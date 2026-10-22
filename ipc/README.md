# Knitting buffer IPC in C++

A standalone Linux C++20 implementation of Knitting's non-stealing buffer
transport. It implements the two-tier layout and XOR publication/retirement
protocol from `src/memory/lock.ts` and `src/memory/regionRegistry.ts`. It has no
payload codec, task execution, worker pool, promises, or stealing.

This is a separate experimental buffer ABI, not wire-compatible with the
JavaScript task headers. Nothing in the existing JavaScript implementation is
changed. The earlier `bench/native-ipc/` mailbox benchmark is a separate
experiment; its performance numbers do not measure this implementation.

## Build and run

```sh
make -C ipc
make -C ipc demo
make -C ipc test
make -C ipc test64
make -C ipc sanitize
python3 ipc/bench.py --output results/ipc-benchmark
```

Only a C++20 compiler and Linux system headers are needed. Outputs go to the
ignored `ipc/build/` directory. The example forks a second process, independently
attaches to the shared mapping, and echoes inline and arena buffers back.

The public API is split into independently includable headers:

| Header | Responsibility |
| --- | --- |
| `layout.hpp` | Shared structures, constants, ABI assertions |
| `mapping.hpp` | memfd creation and attachment |
| `buffer.hpp` | Move-only outgoing/incoming loans |
| `sender.hpp` | Publication, inline slots, arena allocation/reclamation |
| `receiver.hpp` | Receiving, borrowing and release |
| `knitting_ipc.hpp` | Convenience include for the complete API |

Implementations live in `mapping.cpp`, `buffer.cpp`, `sender.cpp` and
`receiver.cpp`. Include the individual headers when using a subset of the API;
existing code can continue including `knitting_ipc.hpp`.

## Memory layout

A memfd-backed shared mapping contains a versioned 64-byte header, then two
independent directional lanes. Each lane has a fixed prefix and an arena:

```text
mapping header: 64 bytes

lane 0: endpoint A → endpoint B
  publication bits:          64-byte line, written by producer
  queue retirement bits:     64-byte line, written by consumer
  region publication bits:   64-byte line, written by producer
  region retirement bits:    64-byte line, written by consumer
  32 slots × 576 bytes (64 in the wide build):
    512-byte inline buffer
     64-byte descriptor (ID, arena offset, length, region ID, storage kind)
  arena: configurable fixed size, default 4 MiB

lane 1: endpoint B → endpoint A
  same layout, independent arena and ownership
```

Queue masks contain 32 bits by default. Compile every translation unit with
`-DKNITTING_IPC_QUEUE_SLOTS=64` for 64 slots and native 64-bit queue masks. Both
variants retain the same two queue control cache lines. The C++ wide build uses
64-bit atomic loads/stores rather than aliasing 32/64-bit atomic objects; it is
not an instruction-for-instruction port of JavaScript's mixed-width wide path.
Mapping format version 2 records the queue width and rejects attachments built
for a different width. Region masks remain two 32-bit words in either build, supporting
64 independently live arena regions. Regions are aligned to 64 bytes. The
producer keeps a private, sorted extent table and reuses gaps after release;
there is no shared malloc/free list. Arena capacity and region identities are
bounded independently. Allocation can fail due to capacity, fragmentation, or
identity exhaustion. Small buffers do not consume arena identities.

The descriptor's first 24 bytes are `u64 id`, `u32 offset`, `u32 length`,
`u32 region`, `u32 storage`; the remaining 40 bytes are reserved. Offsets are
relative to that lane's arena, so processes can map it at different addresses.
All shared structure sizes/offsets important to this layout have compile-time
checks in `layout.hpp`.

## When is a region free?

For a particular bit:

```text
published XOR retired == 0   → reusable
published XOR retired == 1   → reserved / in flight
```

The producer toggles the region publication bit when reserving an arena region.
It writes the payload and descriptor, then release-publishes the queue bit. The
consumer acquire-loads publication before reading either. These are different
events: reserving a region does not itself publish a message.

The consumer uses **separate acknowledgements** for the descriptor and bytes:

1. An inline buffer holds its queue slot until `IncomingBuffer::release()`.
   Release toggles the queue retirement bit.
2. An arena buffer copies its descriptor locally and immediately retires the
   queue slot. It continues borrowing the arena bytes. Only
   `IncomingBuffer::release()` toggles the **region retirement bit**.
3. Before reusing arena memory, the producer acquire-loads retirement bits,
   reconciles completed regions, and removes their extents from its local table.

Release is a release-ordered atomic XOR. The producer's matching acquire observes
the consumer's completed reads before overwriting those bytes. Queue publication
also uses release/acquire. Each side writes its own cache lines; a cached queue
retirement mask is refreshed when the producer runs out of known-free slots.

A large buffer can therefore outlive the queue slot that announced it. The
test suite keeps 64 arena loans alive while recycling the default 32 queue slots, then
releases an arbitrary region above index 31 and verifies only that region is
reused. There is no automatic recycling after a number of subsequent messages.

## API

```cpp
#include "knitting_ipc.hpp"
#include <algorithm>
using namespace knitting::ipc;

auto mapping = Mapping::create();
Sender sender(mapping.lane(0), mapping.arena(0));
// Construct this at the receiving endpoint over its own attachment:
Receiver receiver(mapping.lane(0), mapping.arena(0));

// Produce directly in shared storage. <=512 bytes uses an inline slot.
auto outgoing = sender.try_allocate(8192);
if (outgoing) {
  auto bytes = outgoing->bytes();
  // Fill all bytes that the receiver will read.
  std::fill(bytes.begin(), bytes.end(), std::byte{42});
  if (!outgoing->commit(123)) {
    // Queue full. Keep the loan to retry, or destroy it to cancel.
  }
}

if (auto incoming = receiver.try_receive()) {
  auto bytes = incoming->bytes(); // Borrowed, read-only span; no payload copy.
  auto request_id = incoming->id();
  // Consume bytes, possibly retaining this move-only handle for later.
  incoming->release(); // Destructor also releases. Repeated release is a no-op.
}
```

For an existing source buffer, `sender.try_send(bytes, id)` allocates, copies,
and publishes, returning false on backpressure. No implicit pending list is
created. `try_allocate()` returns an empty optional if it cannot reserve storage;
sizes above the arena limit also return empty. A failed `commit()` retains the
outgoing loan so the caller can retry without regenerating its bytes.

Outgoing and incoming handles are move-only. Destroying an unpublished outgoing
handle cancels its reservation; cancellation undoes the producer's region toggle
without writing the consumer's retirement word. Destroying an incoming handle
releases it. Access through a committed/cancelled/released handle throws, and
release/cancel are idempotent. A raw span retained by user code is **not revoked**:
stop using it after commit, release, cancellation or handle destruction.

`Mapping::attach(fd)` duplicates and maps a previously transferred/inherited
file descriptor, then validates the header, version and mapping bounds. The
creator must finish `Mapping::create()` before handing it over. The demo uses
fork inheritance and a new mapping in the child. Passing the memfd with Unix
socket `SCM_RIGHTS` or arranging inheritance across exec belongs to connection
setup, outside this library; `MFD_CLOEXEC` is enabled by default.

## Scope and lifetime rules

- Exactly one sender and one receiver per direction, each confined to one
  thread. Construct them once for a fresh channel. The opposite direction is
  independent and can be used simultaneously for replies.
- Mapping objects must outlive endpoints, and endpoints must outlive their
  buffer loans. A loan can be retained across application suspension while its
  endpoint stays alive, but access/release must remain on the endpoint's thread.
- Bitmap slots are scanned in rotating order; delivery is **not guaranteed
  FIFO**. IDs are caller-chosen and carried without interpretation.
- The transport is nonblocking and does not allocate heap memory per message.
  It contains no futexes, sockets, sleeps or syscalls on the message/release path.
  Polling, backoff, sleeping and notifications belong to the caller. The example
  uses `std::this_thread::yield()` while waiting; that is outside the transport.
- This ABI assumes Linux process-shared lock-free 32/64-bit atomics, native byte
  order and the compiler ABI verified by the static assertions. It is not a
  portable cross-language standard. Non-C++ implementations need to match the
  layout and memory ordering explicitly.
- Endpoints cooperate and mappings are trusted. Basic descriptor bounds are
  checked, but this is not a security boundary. A peer can alter or truncate its
  writable mapping. Process failure or an abandoned loan does not trigger
  unsafe reclamation: destroy the whole channel after stopping both endpoints.
  There is no endpoint restart, crash recovery, dynamic growth or notification
  layer in this implementation.

## Validation

`tests.cpp` checks inline capacity, independent region lifetimes, both 32-bit
region words, out-of-order release, fragmentation/coalescence, queue pressure,
commit retry, cancellation, move assignment, double release, descriptor bounds
and independently mapped attachment. The two-process duplex stress test sends
20,000 messages in each direction with 0–16 KiB mixed buffers, validates every
byte against its message ID, and detects missing/duplicate responses. These
checks run in optimized and AddressSanitizer/UndefinedBehaviorSanitizer builds.
They test this C++ protocol, not JavaScript wire interoperability.

## Measuring this implementation

See [measured results](BENCHMARKS.md) for the local five-run comparison.

```sh
# Short correctness smoke run; not performance evidence.
python3 ipc/bench.py --smoke --repetitions 1 --output results/ipc-smoke
# Five independent runs/configuration, targeting 350 ms measurement per run.
python3 ipc/bench.py --repetitions 5 --seconds 0.35 --output results/ipc-benchmark
```

The output directory must be new. The runner compiles the actual modular library
with `-O3` (no LTO), saves source copies/hashes and machine/compiler metadata, and
executes each case in a fresh process pair. It pins host and worker to distinct
CPUs (`--cpus HOST,WORKER`, default the first two permitted CPUs), warms the path,
and rotates/reverses mode order between repetitions. Cases run sequentially.

Payloads are 64 B, 512 B, 513 B, 4 KiB and 1 MiB, with 1 or 32 calls per batch.
The 512/513 B boundary exposes arena allocation/reclamation overhead. Every call
includes a request, a full-byte checksum in the worker, a 16-byte reply, host
validation and consumer release. The producer stamps a changing byte on every
request; the worker checks the expected checksum and the host rejects duplicate
or missing replies. Region allocation and retirement are inside timing. Setup,
initial allocations/mappings, fork, warmup and cleanup are excluded.

| Mode | Producer work |
| --- | --- |
| `ipc-copy` | Stamp an existing source, allocate shared storage, copy and publish |
| `uds-copy` | Stamp the same reused source, send over a persistent Unix socket |
| `ipc-direct` | Allocate shared storage, fill every byte in place, publish |
| `uds-direct` | Fill every byte in a reused local buffer, send over the socket |

Compare copy with copy, and direct production with direct production. The direct
modes include an additional full producer write and represent a different
workload from copying existing data. The socket baseline aggregates a batch's
request descriptors into one write, payload bytes into another, and returns all
replies in one write. The IPC implementation publishes and releases individual
messages. Neither baseline does per-message heap allocation. Sockets handle
partial writes/reads and preserve the same ID/size/checksum validation.

IPC waits busy-poll; sockets block in kernel reads/writes. CPU time sums both
processes, so the cost of spinning is visible. This is a saturated two-core
comparison, not a comparison of blocking wakeup mechanisms or idle efficiency.
There is no socket-plus-shared-payload baseline in this harness, and a win here
does not establish superiority over that design or over iceoryx.

Calls/s counts completed request/reply pairs. At window=1, p50/p99 describe
request round trips. At window=32, they describe whole-batch round trips and must
not be presented as individual latency. Timing overhead is included. Summaries
use medians of per-run metrics (including median per-run p99), with throughput
min/max and raw run durations. Calibration has iteration caps; inspect actual
durations and increase run length/repetitions when interpreting small gaps.
Raw JSON, summary JSON, `report.md` and exact source copies are saved locally.

### Quick iceoryx2 comparison

[Results and settings](ICEORYX_BENCHMARKS.md) compare this C++ implementation
with iceoryx2 0.10.0's native Rust API, using two one-way services and spinning
on both sides. The optional comparison requires Rust/Cargo in addition to the
C++ toolchain; ordinary IPC builds do not depend on Rust or iceoryx2.
The [wide-queue comparison](WIDE_BENCHMARKS.md) measures 32- and 64-slot builds
against the same iceoryx2 setup, including batches of 64.

```sh
python3 ipc/compare_iceoryx.py --repetitions 3 --seconds 0.25 \
  --output results/ipc-iceoryx
# Compare 32- and 64-slot builds with iceoryx2, including batches of 64.
python3 ipc/compare_iceoryx.py --wide --repetitions 3 --seconds 0.2 \
  --output results/ipc-wide
```
