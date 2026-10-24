# C++ buffer IPC

A Linux C++20 shared-memory channel based on Knitting's publication and
retirement masks. Each direction has one producer, one consumer, inline storage
for buffers up to 512 bytes, and an arena with 64 independent region identities.
The default queue has 32 slots; a 64-slot build is available.

This is an experimental standalone ABI. It is not compatible with JavaScript
Knitting's task frames. It requires a 64-bit little-endian Linux process and
lock-free native atomics. The channel provides polling APIs; callers control
waiting and notifications.

## Build

```sh
make -C ipc                         # static library, demo, tests
make -C ipc demo                    # echo buffers between two processes
make -C ipc check                   # both queue widths and standalone headers
make -C ipc sanitize sanitize64     # ASan/UBSan, both queue widths
```

The library is `ipc/build/libknitting_ipc.a`. Include `knitting_ipc.hpp` or the
individual headers and link the library:

```sh
g++ -std=c++20 -Iipc example.cpp ipc/build/libknitting_ipc.a -o example
```

For 64 slots, build a separate library and use the same definition in callers:

```sh
make -C ipc QUEUE_SLOTS=64 BUILD=build/64
# Add -DKNITTING_IPC_QUEUE_SLOTS=64 when compiling the caller.
```

For hot-path optimization, compile both the library and caller with `-O3 -flto`.
This lets the compiler inline across the library boundary.

## Buffer ownership

```cpp
auto outgoing = sender.try_allocate(size);
if (outgoing) {
  produce(outgoing->bytes());
  if (!outgoing->commit(message_id)) {
    // Queue full: retain the loan to retry, or destroy it to cancel.
  }
}

if (auto incoming = receiver.try_receive()) {
  consume(incoming->id(), incoming->bytes());
  incoming->release(); // Destruction also releases.
}
```

For an open set of currently ready messages, use:

```cpp
receiver.drain([&](knitting::ipc::IncomingBuffer incoming) {
  consume(incoming.id(), incoming.bytes());
}); // Publishes the completed retirement masks, including on exceptions.
```

This never waits for a full batch. A callback can move a loan into application
storage to retain it; its later release remains independent. Do not recursively
receive on this endpoint in the callback. Call `receiver.flush_retirements()`
before a callback blocks or retries on peer-dependent backpressure. Individual
`try_receive()` loan releases outside a drain still publish immediately.

`try_send(bytes, id)` copies an existing buffer. Small buffers copy and publish
directly; arena buffers use a temporary outgoing loan.
`try_allocate()` lets the producer write directly into shared memory. Neither
operation queues a retry internally. Empty allocation results indicate exhausted
slots, region identities, contiguous arena capacity, or an oversized request.

An incoming inline buffer retains its queue slot. An incoming arena buffer
retires the descriptor slot and retains only its payload region. Retirement is
immediate outside an explicit drain and coalesced at drain exit within one.
The producer reclaims that region after observing its release bit. Arena
allocation defaults to eager first-fit reclamation for a compact working set;
pass `ArenaReclamation::on_pressure` as the sender's third constructor argument
to append locally and reconcile only at byte/identity pressure. This optional
policy trades fewer retirement observations for a larger working set.

Handles are move-only. Destroying an unpublished outgoing handle cancels it;
destroying an incoming handle releases it. A retained raw span becomes invalid
after commit, cancel, or release. Metadata accessors remain available, but byte
access through a disowned handle throws. Fill every byte the receiver will read;
new loans are not zero-initialized.

Endpoints are confined to one thread and constructed once for a fresh direction.
The mapping must outlive the endpoints, and endpoints must outlive their loans.
Delivery is not FIFO. Process failure requires replacing the channel after both
endpoints stop; there is no automatic reclamation of abandoned loans.

## Files

| File | Responsibility |
| --- | --- |
| `layout.hpp` | Shared structures, constants, ABI assertions |
| `mapping.hpp` / `mapping.cpp` | memfd creation, attachment, mapping ownership |
| `buffer.hpp` / `buffer.cpp` | Move-only producer and consumer loans |
| `sender.hpp` / `sender.cpp` | Reservation, publication, arena reclamation |
| `receiver.hpp` / `receiver.cpp` | Descriptor consumption and retirement |
| `knitting_ipc.hpp` | Public convenience include |
| `detail.hpp` | Internal endpoint-view validation |
| `demo.cpp` | Two-process request/reply example |
| `tests.cpp` | Ownership, bounds, pressure and duplex tests |

[PROTOCOL.md](PROTOCOL.md) defines the layout, state transitions, memory ordering,
and endpoint contract. The channel has no payload codec, scheduler, worker pool,
or work stealing. It is not included in the npm package.

[Benchmark commands and methods](benchmarks/README.md) cover the basic Unix
domain socket comparison.
