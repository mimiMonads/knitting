# Windows Process Worker Hang — Investigation & Fix

**Branch:** `windows/ProcessSharedBuffer`
**Date:** 2026-05-29
**Status:** Fixed and verified (7/7 process-worker tests pass on Node + Bun)

---

## TL;DR

Process workers (`worker: { runtime: "process" }`) hung the CI runners on
Windows. The investigation found **two distinct Windows-only defects**, not one:

1. **Fake-fd bug** — the shared-memory handle could not be reopened in the child
   process, causing a *fast failure* (child exits with code 1). Not the hang.
2. **Parked-worker hang** — a worker parked on a native wait could *never be
   woken across processes* on Windows, so it slept for the full park timeout
   (up to 5 s) before noticing new work. This is what made CI appear to hang.

Both are fixed on this branch. The fixes are pure-software (no behavior change
on Linux/macOS).

---

## Background: how process workers share memory

A process worker is a *separate OS process*, not a thread. To exchange data with
it, the host allocates a shared-memory region and the child maps the **same
physical memory** into its own address space.

- **POSIX (Linux/macOS):** the region is referenced by a **file descriptor**.
  The fd is inherited by the child via `stdio`, so the same integer is valid in
  both processes.
- **Windows:** there are no inheritable fds for this. The only cross-process-safe
  mechanism is a **named file mapping** (`CreateFileMappingW` /
  `OpenFileMappingW`). The child reopens the region *by name*.

This difference is the root of both bugs.

---

## Bug #1 — Fake fd across processes (fast failure)

### What happened

On Windows, the Node native addon (`knitting_shared_memory.node`) keeps a
**process-local registry**:

```cpp
std::atomic<int> next_mapping_id;
std::unordered_map<int, HANDLE> registry_handles;
```

`createSharedMemory` returned an *integer registry id* as the `fd`. That integer
is meaningless in any other process. When the child tried to map the region with
that fd, the addon called `DuplicateRegisteredMappingHandle(fd)`, found nothing
in its (empty) registry, and failed:

```
DuplicateHandle failed: The operation completed successfully.
Worker exited with code 1
```

The host's exit-event detection then rejected the pending call. **This is a fast
failure, not an indefinite hang** — but it still broke process workers on
Windows.

### The fix

Always create a **named** mapping and carry the name across the process boundary
so the child reopens by name instead of by the meaningless fd.

- `pool.ts` now generates a unique mapping name per region:

  ```ts
  knitting_process_worker_<pid>_<thread>_<timeTag>_<counter>_<randomTag>
  ```

- The name is stored in the `FileDescriptor` metadata and serialized to the
  child (`FileDescriptor.toMetadata()`).
- On Windows the C++ `MapSharedMemory` takes the **named path**
  (`OpenFileMappingW(name)`) when a name is present; the old fd path
  (`DuplicateRegisteredMappingHandle`) is only used when there is *no* name
  (POSIX fd inheritance).
- fd inheritance wiring (`stdin` / `stdio`) is only set up when the descriptor
  has **no name** (i.e. POSIX). On Windows, stdin is `"ignore"` (Node/Bun) or
  `"null"` (Deno) because the child gets the region by name.
- A hard guard throws early if a Windows process worker somehow ends up without
  a named mapping, so this can never silently regress:

  ```ts
  if (isWindowsRuntimeHost() && descriptor.name === undefined) {
    throw new Error("Windows process worker shared memory must use a named mapping");
  }
  ```

- `loop.ts` (child side) keys cached mappings by **name when present**, else by
  fd:

  ```ts
  const mappingKey = (descriptor) =>
    descriptor.name === undefined
      ? `fd:${descriptor.fd}:${descriptor.size}:${descriptor.runtime ?? ""}`
      : `name:${descriptor.name}:${descriptor.size}:${descriptor.runtime ?? ""}`;
  ```

---

## Bug #2 — Parked worker can never be woken (the real CI hang)

### What happened

The worker idle loop (`sleepUntilChanged` in `src/worker/timers.ts`) parks on a
native wait when there is no work, for up to `parkMs` milliseconds. The host is
supposed to **wake** the parked worker the moment it enqueues a task.

On Windows this wake **does not work across processes**:

- The native wake uses `WakeByAddress`, which is **keyed to a virtual address**.
- The host and the child map the *same physical page* at *different virtual
  addresses*. A wake issued on the host's address can never reach a thread
  waiting on the child's address.
- Accordingly, the addon's `FutexWake` on Windows is a **no-op**:

  ```cpp
  #elif defined(_WIN32)
    (void)addr;
    return count <= 0 ? 0 : 1;   // does nothing
  ```

- The native `FutexWait` on Windows is itself just a **1 ms polling loop** that
  returns early only if the *watched value* changes.

So a Windows Node process worker that parked with `parkMs: 5000` would sleep for
the **full 5 seconds** before re-checking for work — because no wake could reach
it, and the watched value alone did not reflect every kind of progress. The
test's call timeout fired first, and CI reported a hang.

### The fix

Since there is no working cross-process wake on Windows, the worker must
**rediscover work by polling**. Cap the native wait at **1 ms** on
plain-Node-Windows so each poll slice is short:

```ts
const isPlainNodeWindows =
  process?.platform === "win32" &&
  typeof process?.versions?.node === "string" &&
  process?.versions?.bun === undefined &&
  Deno === undefined;

// Windows has no working cross-process wake. WakeByAddress is keyed to a
// virtual address, so a host cannot wake a worker parked on the same physical
// page mapped at a different address in the child — FutexWake is a no-op there.
// A parked Windows Node process worker can therefore never be signalled and
// must rediscover work by polling. Cap the native wait at 1 ms so it re-checks
// every millisecond instead of sleeping the full parkMs.
const nativeWaitTimeoutMs = (parkMs?: number): number =>
  isPlainNodeWindows ? 1 : parkMs ?? 60;
```

This only affects the **native-wait branch**, which is exclusively the
process-worker path on Windows Node. Thread workers (same process, real
`Atomics.wait`) are unaffected and keep their normal `parkMs`. Linux/macOS and
Bun/Deno are unaffected.

The cost is a 1 ms-granularity busy-poll on idle Windows Node process workers —
a pragmatic trade given the platform limitation. A future "real" fix would be a
named `CreateEventW`/`OpenEventW` object signalled on wake, but that requires C++
changes and rebuilt prebuilds for every platform.

---

## Why the DLL is *not* involved

`knitting_windows_shared_memory.dll` exists only for **Bun and Deno FFI**
(`dlopen`). **Node never uses it** — Node loads `knitting_shared_memory.node`
(the Node native addon). No Node process-worker test touches the DLL.

---

## Files changed (vs. the pre-fix commit)

| File | What changed |
|------|--------------|
| `src/runtime/pool.ts` | Named-mapping generation, `mode: "create"`, Windows guard, fd-inheritance only when unnamed, Node now uses IPC boot, removed POSIX-only gate |
| `src/worker/loop.ts` | Mapping cache keyed by name when present; missing-boot-payload guard |
| `src/worker/timers.ts` | `isPlainNodeWindows` detection + 1 ms native-wait cap + accurate root-cause comment |
| `test/runtime.process.test.ts` | Removed POSIX-only assumption, per-call timeout labels, robust shutdown handling, parked-wait wake test |
| `test/file-descriptor.test.ts` | Updated for named-mapping metadata |

```
 src/runtime/pool.ts            |  89 +++++++---
 src/worker/loop.ts             |  15 ++-
 src/worker/timers.ts           |  37 ++++--
 test/file-descriptor.test.ts   |  34 +++--
 test/runtime.process.test.ts   | 141 +++++++++++++++-----
```

---

## Verification

`test/runtime.process.test.ts` on Node:

```
✔ process worker diagnostics harness is alive
✔ process worker spawns a Bun child from this runtime      (348 ms)
✔ process worker spawns a Deno child from this runtime
✔ process worker spawns a Node child from this runtime     (440 ms)
✔ process worker supports a command prefix wrapper
✔ Deno process worker honors runtime permission flags
✔ Node process worker wakes promptly from a parked native wait (448 ms)

tests 7 | pass 7 | fail 0 | skipped 0
```

The "wakes promptly" test asserts the parked worker responds in **< 1000 ms**;
it now completes in ~448 ms (before the fix it would block ~5000 ms and the test
would time out → the CI "hang").

A standalone reproduction script with hard timeouts
(`scripts/reproduce-hang.ts`, untracked — has a machine-specific Bun path)
exercises real node/bun roundtrips and passes 6/6 (~390 ms each) on this branch.

---

## Commit history note

The fix logic landed across five exploratory commits with throwaway
`test:` messages (`619d77b` … `966b7e4`). A follow-up commit
(`f6cab46`, `fix: document Windows process worker hang root cause + cap native
wait`) refines the timer comment to state the real root cause and gives the
branch one honest, well-described entry.

**As of writing, these commits are NOT pushed to origin.**
