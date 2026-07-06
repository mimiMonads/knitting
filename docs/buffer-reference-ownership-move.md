# BufferReference: ownership-move redesign

Status: in progress (branch `experimental/bufferReference`)

## Goal

Make `BufferReference` (the `knitting/unsafe` zero-copy buffer handle for
**thread** workers) safe by switching from _shared mutable aliasing_ to an
_ownership move_, while keeping it zero-copy for large payloads (the win is ~1
MiB+ buffers where serializing through the SAB transport costs real time).

The move must work on **all three runtimes** (Node, Deno, Bun). Where an engine
cannot hand cross-isolate ownership to the consumer, the consumer takes a single
copy instead — the protocol is identical, only the materialize primitive
differs.

## What is unsafe today

1. **Shared mutable aliasing.** The producer's `ArrayBuffer` is _not_ detached
   on send, so producer and consumer alias the same bytes with no
   synchronization.
2. **Raw-pointer lifetime.** The consumer materializes a view over the
   producer's address; if the producer frees/moves it, or the consumer keeps the
   pointer past task settle, it is a use-after-free.

## Core idea

- **`transfer` / detach on construct = nullify the source.** After construction
  only the `BufferReference` owns the bytes; the producer literally cannot touch
  the old handle. This removes the concurrent-aliasing race by language
  semantics, not by convention.
- **Engine-managed backing store.** We keep the backing store alive through the
  engine (a held, transferred `ArrayBuffer` and/or a retained
  `shared_ptr<BackingStore>`), so the GC never collects it mid-flight and we
  avoid hand-rolled SAB/resize logic.
- **Drain-gated release.** The producer releases its hold only once the consumer
  has materialized. On the return path this is detected from the lock's control
  words (XOR == 0 over the whole word = channel quiescent = every reference
  taken).

## The refcount lifeline (the one invariant)

> The producer holds a reference from `produce` until `release`, and the
> consumer takes its **own independent** reference (`adopt`) **before** the
> producer releases. Ordering is enforced by drain (return) or task-settle
> (forward).

As long as this holds, the live reference count never reaches zero while either
side needs the bytes — no UAF, no double free, regardless of timing.

## Physics per engine

| Capability                     | Node (V8 + N-API addon)                                         | Deno (V8 + FFI)                    | Bun (JSC + FFI)         |
| ------------------------------ | --------------------------------------------------------------- | ---------------------------------- | ----------------------- |
| Read pointer of a view         | addon `getPointer`                                              | `Deno.UnsafePointer.of`            | `Bun.FFI.ptr`           |
| Detach/nullify source          | addon `Detach` / `transferToFixedLength`                        | `transferToFixedLength`            | `transferToFixedLength` |
| Materialize alias (non-owning) | addon `wrapPointer` (NoopDeleter)                               | `UnsafePointerView.getArrayBuffer` | `Bun.FFI.toArrayBuffer` |
| **Owning cross-isolate adopt** | **yes** — `ArrayBuffer::New(isolate, shared_ptr<BackingStore>)` | no                                 | no                      |

Conclusion:

- **Forward path (host → worker input): true zero-copy move on all three.** The
  worker aliases the producer's bytes during the call; the host releases on
  task-settle (after the worker has finished, so it is ordered for free).
- **Return path (worker → host result): zero-copy on Node by default, one copy
  on Deno/Bun by default, or borrowed zero-copy on Deno/Bun with
  `unsafe: { BufferReferenceReturn: "borrow" }`.** Node's host `adopt` co-owns
  the backing store (`shared_ptr`), so the worker's drain-release just drops the
  registry's extra ref and the host keeps the bytes. Deno/Bun's host cannot
  co-own a foreign-isolate backing store via FFI; the safe default copies during
  decode. The borrowed fast path instead keeps the worker's producer hold pinned
  and has the host send an explicit release message when the returned
  `BufferReference` is released.

This is the best each engine physically allows for owned returns; borrowed
returns are the opt-in pointer-moving path on engines that only expose
non-owning foreign-pointer aliases.

## Native capability layer

A single module, `src/connections/buffer-reference-native.ts`, exposes a uniform
interface and hides the per-runtime mechanics:

```ts
type ProducedBuffer = {
  token: bigint; // producer-side release handle
  pointer: bigint; // address of the region start (offset already applied)
  byteLength: number;
};

type BufferReferenceCapabilities = {
  runtime: "node" | "deno" | "bun";
  supportsOwningAdopt: boolean; // consumer keeps bytes after producer release
  produce(view: ArrayBufferView): ProducedBuffer; // detaches source, pins backing
  adopt(
    p: { token: bigint; pointer: bigint; byteLength: number },
    opts?: { copy?: boolean },
  ): ArrayBuffer; // owning (Node) or alias/copy
  release(token: bigint): void; // drop producer hold
};
```

- **Node** routes to addon `retainBackingStore` / `adoptBackingStore` /
  `releaseBackingStore`; `supportsOwningAdopt = true`. Falls back to the legacy
  `retainPointer`/`wrapPointer` (non-owning) if an older prebuild lacks the new
  exports, so the package still loads before a native rebuild.
- **Deno / Bun** route to FFI; the producer pins the transferred `ArrayBuffer`
  in a process-global JS registry keyed by token; `adopt` aliases the pointer
  (and copies when `copy` / retain is required); `supportsOwningAdopt = false`.

## Node addon additions (`src/knitting_buffer_pointer.cc`)

A process-global, mutex-guarded registry of `shared_ptr<v8::BackingStore>` keyed
by token:

- `retainBackingStore(buffer)` → `GetBackingStore()` into the registry,
  `Detach()` the source in the same call, return
  `{ pointer, byteOffset, byteLength, token }`. The backing store survives the
  detach because the registry holds the shared_ptr.
- `adoptBackingStore(token)` → `ArrayBuffer::New(isolate, store)` in the
  caller's isolate (an owning, GC-managed ArrayBuffer that co-owns the store).
  Does not remove the entry.
- `releaseBackingStore(token)` → drop the registry's shared_ptr ref.

Legacy
`getPointer`/`retainPointer`/`releasePointer`/`wrapPointer`/`detachArrayBuffer`
stay for the fallback path. Requires `bun run build:native` on a Node toolchain
and refreshed `prebuilds/`.

## Transport integration

### Forward (host → worker)

- `new BufferReference(view)` calls `produce(view)` → source detached, backing
  pinned, metadata carries `{ pointer, byteLength, token, origin, runtime }`.
- Worker decode builds a `BufferReference` from metadata; `toArrayBuffer()`
  calls `adopt` (owning on Node, alias on Deno/Bun — the worker uses it during
  the call, so an alias is safe).
- Host releases its hold on **task settle** via the existing finalizer wiring
  (`attachPayloadTransportFinalizer` + `runTaskFinalizers`, added in `43ee3e7`).

### Return (worker → host) — as implemented

- The worker function returns a `BufferReference`; it is encoded as a dedicated
  raw-word `BufferReference` static payload on the return lock (same finalizer
  attachment as the forward leg, but no JSON metadata encode/decode).
- **Host claims eagerly in the codec `decode`**, gated by
  `RUNTIME_IS_MAIN_THREAD` (host = return; worker thread = forward = lazy
  alias). This runs inside `resolveHost` _before_ it flips `workerBits`.
  Owning/copy modes take the bytes right there; borrow mode only records the
  claim and adopts on first read (see “Borrow hardening” below), which is safe
  because the explicit release protocol keeps the worker pin held either way.
- Safe Deno/Bun returns copy during decode. Opt-in borrowed Deno/Bun returns
  alias the pointer during decode, keep the worker producer hold in an
  explicit-release map, and release it when `BufferReference.release()` /
  `[Symbol.dispose]()` / the host GC finalizer posts a token-release message
  back to that worker.
- Otherwise, the worker keeps the return payload's producer-release in a
  **pending-release queue** in `rx-queue.ts` (`sendReturn` captures
  `slot.finalize` before the slot recycles) instead of releasing on settle.
- The worker `loop` (`src/worker/loop.ts`) calls `drainReturnReleases()` each
  iteration: it reads the **return lock's two control words** atomically
  (`returnLock.hostBits`/`workerBits`, not the cached shadows) and, when the
  channel is quiescent (`(hostBits ^ workerBits) === 0`), releases every queued
  token. Global quiescence sidesteps per-bit ABA: at all-agree, every published
  return has been acked. Early-outs on an empty queue, so non-BufferReference
  workloads pay only a length check.

## API / metadata changes

- `BufferReferenceMetadata` gains `token: string`.
- `toArrayBuffer()` / `toUint8Array()` semantics: returns an **owned** buffer on
  Node; on Deno/Bun returns an alias for in-call/borrowed use and a copy when
  retained past release in the safe default mode.
- `release()` / `[Symbol.dispose]()` explicitly drops borrowed returned
  references and tells the producing worker it can release its pinned backing
  store.
- Producing detaches the source: reading the original view after construction
  throws (it is the move). Documented as the contract.
- Process-worker use still throws (raw pointers are process-local) — unchanged.

## Tests

- Rework `test/buffer-reference.test.ts` for move semantics: source is detached
  after construct; consumer sees the same bytes; host result survives worker
  release (the refcount proof); offset/length views; zero-length guard;
  process-worker rejection.
- New `test/buffer-reference-native.test.ts`: `produce → adopt → release`
  round-trip + source-detach + copy-mode, runnable on Deno and Bun (FFI paths).
- 1 MiB round-trip both directions through a real pool.

## Milestones

1. **Foundation — DONE.** Node C++ owning primitives,
   `buffer-reference-native.ts` capability layer (Deno + Bun FFI, Node addon w/
   fallback), addon type update, `buffer-reference-native.test.ts`.
2. **BufferReference refactor — DONE.** `produce/adopt/release` routed through
   the layer; detach-on-construct (the move); metadata gained `token` +
   `byteOffset`; producer GC backstop via `FinalizationRegistry`;
   `buffer-reference.test.ts` rewritten for move semantics. Full Deno suite
   (248)
   - Bun green.
3. **Return path — DONE.** Worker returns an explicit `BufferReference` (encoded
   as the existing external payload on the return lock). The host claims
   ownership **eagerly in the codec decode**, gated by `RUNTIME_IS_MAIN_THREAD`
   (host = return = eager owning/copy; worker thread = forward = lazy alias) —
   no lock.ts hot-path hook, no per-call closure. The worker defers the return
   payload's producer-release into a pending queue in `rx-queue.ts` and drains
   it from the worker `loop` when the return lock is quiescent
   (`returnLock.hostBits ^ returnLock.workerBits == 0`). Fixtures
   `returnsBuffer`
   - `echoBufferPlusOne`; full Deno suite (250) + Bun green.
4. **Hardening — mostly DONE.** README + `ref.ts` rewritten to the move contract
   (both verified runnable on Deno + Bun); `bench/buffer-reference.ts` added
   (BufferReference round trip vs Uint8Array transport). Shutdown-drain is
   **deferred by design** — see open risks. Node build/bench pending a Node
   toolchain.

### Benchmark (2026-06-03, threads: 1, avg per call, round trip)

Median of three runs of `bench/buffer-reference.ts --json`, with
`unsafe: { BufferReferenceReturn: "borrow" }` enabled and each returned
reference released immediately.

| runtime | size    | BufferReference | Uint8Array transport | speedup |
| ------- | ------- | --------------- | -------------------- | ------- |
| Node    | 8 KiB   | 0.039 ms        | 0.024 ms             | 0.63x   |
| Node    | 64 KiB  | 0.065 ms        | 0.118 ms             | 1.81x   |
| Node    | 256 KiB | 0.125 ms        | 0.496 ms             | 3.97x   |
| Node    | 1 MiB   | 0.262 ms        | 1.664 ms             | 6.35x   |
| Node    | 4 MiB   | 1.633 ms        | 4.159 ms             | 2.55x   |
| Node    | 8 MiB   | 2.328 ms        | 8.046 ms             | 3.46x   |
| Deno    | 8 KiB   | 0.069 ms        | 0.036 ms             | 0.52x   |
| Deno    | 64 KiB  | 0.104 ms        | 0.078 ms             | 0.75x   |
| Deno    | 256 KiB | 0.154 ms        | 0.341 ms             | 2.22x   |
| Deno    | 1 MiB   | 0.554 ms        | 2.255 ms             | 4.07x   |
| Deno    | 4 MiB   | 3.459 ms        | 6.075 ms             | 1.76x   |
| Deno    | 8 MiB   | 6.051 ms        | 9.990 ms             | 1.65x   |
| Bun     | 8 KiB   | 0.057 ms        | 0.033 ms             | 0.57x   |
| Bun     | 64 KiB  | 0.095 ms        | 0.110 ms             | 1.17x   |
| Bun     | 256 KiB | 0.237 ms        | 0.278 ms             | 1.17x   |
| Bun     | 1 MiB   | 1.288 ms        | 1.178 ms             | 0.91x   |
| Bun     | 4 MiB   | 3.363 ms        | 4.554 ms             | 1.35x   |
| Bun     | 8 MiB   | 4.645 ms        | 8.682 ms             | 1.87x   |

The borrowed return path removes the Deno/Bun returned-payload copy. The round
trip still grows with buffer size because this benchmark's task body allocates
an output buffer and copies bytes into it (`out.set(src)`). A no-work identity
task would isolate pointer-move overhead more directly, but it would also need a
separate ownership protocol for returning the same host-produced buffer.

## Borrow hardening: revocation instead of lifetime (2026-07)

Non-owning engines cannot keep a foreign isolate's backing store alive, so the
borrowed return path enforces the dual invariant instead: **no reachable view
may ever observe freed memory.** Two proofs are used, and every path to dropping
a pin is preceded by one of them:

1. **Revocation.** `release()` detaches every alias buffer the reference handed
   out (`detachArrayBufferBestEffort`) _before_ the worker pin drops. Detaching
   neutralizes all views (they read as empty / throw); it is free
   (`transferToFixedLength(0)` on FFI aliases, addon `Detach` on Node) and
   verified by a CI canary in `buffer-reference-native.test.ts`.
2. **Proof of deadness.** Before the first read no view can exist, so the
   borrow's `FinalizationRegistry` backstop watches the `BufferReference`
   itself; the first materialize migrates it onto the **alias ArrayBuffer**.
   Views strongly reference their buffer, so the GC-driven release can only fire
   once no view can reach the bytes — a ref dropped while a view escapes no
   longer unpins. The adopt stays lazy on purpose: FFI aliases charge their
   byteLength to the consumer's GC, so an eager adopt made every borrowed return
   pay a size-scaled GC-accounting cost even when never read (measured ~4x on
   Bun 4 MiB returns).

The fallback rule is **leak-not-UAF**: if a detach fails, `release()` does not
send the token release; the backstop stays registered and retries once the
buffers are truly unreachable. The producer backstop uses the same idea as a
shared countdown over the reference plus every materialized alias buffer.

**Shutdown barrier.** Each lane tracks outstanding borrowed returns in a
`Map<token, WeakRef<BufferReference>>` (fed by the `track` hook of
`BufferReferenceReturnHooks`). Before a worker dies, `markWorkerClosed` revokes
them via `revokeBorrow`: on graceful shutdown/kill the bytes are copied first,
so held references stay readable while stale views go empty; on crash/exit the
aliases are detached only, so reads fail loud instead of aliasing freed memory.

## First-class SharedArrayBuffer transport

Separate feature, built on the same capability layer (`produceShared` /
`adoptShared` / `releaseShared`) but otherwise independent of `BufferReference`
— a SAB is native to JS and is passed as a plain task argument/return:

```ts
const sab = new SharedArrayBuffer(1 << 20);
await pool.call.initWorker(sab); // shared by reference, zero copy
```

- **Pointer alias, every runtime** (the chosen design — `postMessage` is an
  anti-goal; knitting replaces it). The encoder detects a `SharedArrayBuffer`
  ([payloadCodec.ts](../src/memory/payloadCodec.ts) dispatch) and ships it as an
  external payload carrying `{ pointer, token, byteLength }`; the consumer
  materializes a **non-owning `ArrayBuffer` alias** over the same physical bytes
  via `getPointer` + `wrapPointer` (Node) / FFI (Deno/Bun). Cross-thread writes
  are visible both ways (same memory); it is thread-workers-only (process
  workers reject it on the origin check).
- **No native registry, GC-managed pin.** The producer pins the SAB in a JS
  `WeakMap` keyed by the SAB itself (share-once), released by a
  `FinalizationRegistry` when the SAB is collected — so the pin tracks the
  producer's SAB lifetime, with no settle/drain coupling. See
  [shared-array-buffer-payload.ts](../src/connections/shared-array-buffer-payload.ts).

### Lesson: why NOT a real cross-isolate SAB

The first attempt reconstructed a real `SharedArrayBuffer` in the worker via
`v8::SharedArrayBuffer::New(isolate, store)` (cross-thread Atomics worked). It
**segfaulted on teardown**: a worker isolate co-owning the shared backing store,
then terminated by `terminateWorkerQuietly`, corrupts the store. A second cause
was holding the SAB's `shared_ptr<BackingStore>` in the **static** C++ registry
— GC-released, so it often outlived V8 and the static map's destructor freed it
after shutdown. Both are avoided by the pointer-alias + JS-Map-pin design above;
the `SharedArrayBuffer::New` path was removed from the addon entirely.

## Open risks

- Node owning path is untestable in this sandbox (no Node toolchain); validate
  on CI after `build:native`.
- Sustained return traffic defers reclamation until the channel next quiesces;
  the pending-release queue holds pinned buffers until then (bounded by memory;
  backpressure is otherwise desirable). Consider a high-water fallback later.
- ~~Borrowed Deno/Bun returns must be released before shutting down the
  producing worker.~~ Resolved by the shutdown barrier (see “Borrow hardening”
  above): outstanding borrows are revoked — copy-then-detach on graceful
  shutdown, detach-only after a crash — before the worker terminates.
- `GetBackingStore()` / `ArrayBuffer::New(isolate, store)` are stable V8 APIs
  since 7.9; confirm no deprecation noise on the Node 22 ABI used by
  `prebuilds/`.
- **Shutdown-drain is deferred.** Pool teardown is an abrupt
  `terminateWorkerQuietly` with no graceful worker-side hook, so a clean
  in-worker drain is not wireable against a hard terminate. In the steady state
  this is a non-issue: the worker `loop` drains the pending-release queue every
  time the return lock quiesces, so by the time a pool is idle/shut down the
  queue is normally empty. The only leak is a worker terminated **mid-flight**
  with un-acked returns: on Deno/Bun the producer holds are freed with the
  isolate; on Node the process-global `shared_ptr<BackingStore>` entries persist
  until process exit. A future signal/exit handler can flush them.
