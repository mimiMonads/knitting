# Buffer channel protocol, version 2

This document specifies the C++ implementation in this directory. “Must” states
an endpoint precondition or protocol requirement. The format is experimental;
it does not specify JavaScript task frames or a portable C++ interprocess ABI.

## Participants and lifetime

A mapping contains two independent directions. Endpoint A sends on direction 0
and receives on direction 1; endpoint B does the reverse. Each direction has
exactly one producer and one consumer, each confined to one thread. All control
words and the producer's local allocator state start at zero.

Endpoints must be constructed once for a fresh direction. Creating another
endpoint over live state, copying endpoint state across a fork to use both
copies, or rebuilding an endpoint over an existing channel violates the
contract. Mapping attachment alone does not claim an endpoint.

A mapping must outlive its endpoints, and endpoints must outlive their loans.
Producer and consumer handles are move-only. Moving transfers responsibility;
explicit cancellation/release and destruction perform that responsibility at
most once. Raw spans cannot be revoked and must not be used after ownership ends.

## Platform and representation

The implementation requires 64-bit little-endian Linux and lock-free 32-bit
atomics. A 64-slot build also requires lock-free 64-bit atomics. Structure sizes,
alignment and offsets are checked at compile time. All participants must agree
on this ABI, queue width, and integer representation.

Shared atomic objects are accessed at their declared width. In particular, the
64-slot C++ build does not alias a 64-bit atomic with two 32-bit atomics. Its
full-width loads/stores differ from JavaScript Knitting's mixed-width wide path.

## Mapping

`Mapping::create(arena_bytes)` creates a memfd with two fixed arenas. Arena size
is a multiple of 64 bytes in [64 B, 1 GiB]; the default is 4 MiB per direction.
The file descriptor has close-on-exec enabled. Passing it by inheritance or
`SCM_RIGHTS` is connection setup, outside the message protocol.

The first 64 bytes are:

| Byte offset | Field | Representation |
| ---: | --- | --- |
| 0 | magic | `u64`, `0x314350494e544e4b` |
| 8 | version | `u32`, 2 |
| 12 | arena size per direction | `u32`, bytes |
| 16 | total mapping size | `u64`, bytes |
| 24 | ready | atomic `u32`, initially 0 |
| 28 | queue slot count | `u32`, 32 or 64 |
| 32 | reserved | 32 bytes, initially zero |

The creator initializes the lanes and header, then release-stores ready=1.
It must complete creation before handing over the descriptor. An attaching peer
duplicates the descriptor, maps the file, acquire-loads ready, and validates the
magic, version, geometry, queue width and file length. Attachments built for a
different queue width are rejected.

For N queue slots and A arena bytes:

```text
lane prefix = 256 + N × 576 bytes
lane stride = lane prefix + A
mapping size = 64 + 2 × lane stride
lane[d] starts at 64 + d × lane stride
arena[d] starts immediately after its lane prefix
```

All terms are multiples of 64 bytes. Each lane prefix starts with:

| Lane byte offset | Field | Writer |
| ---: | --- | --- |
| 0 | queue publication mask | producer |
| 64 | queue retirement mask | consumer |
| 128 | region publication masks, two `u32` words | producer |
| 192 | region retirement masks, two `u32` words | consumer |
| 256 | slot array | producer writes; consumer reads |

Each control field occupies a separate 64-byte cache line. Queue masks are
native `u32` for 32 slots or native `u64` for 64 slots. The region masks always
use two `u32` words: region r is bit `r % 32` in word `r / 32`.

## Slots and descriptors

Each 576-byte slot contains 512 inline bytes followed by a 64-byte descriptor:

| Descriptor byte offset | Field | Representation |
| ---: | --- | --- |
| 0 | message ID | `u64`, caller-defined |
| 8 | arena offset | `u32`, relative to this direction's arena |
| 12 | buffer length | `u32`, bytes |
| 16 | region identity | `u32` |
| 20 | storage kind | `u32`, 0=inline, 1=arena |
| 24 | reserved | 40 bytes, producer leaves zero; consumer ignores |

Inline descriptors have length 0–512, offset 0 and region 0. Their bytes are at
the beginning of the associated slot. Arena descriptors have length greater
than 512, region identity 0–63, a 64-byte-aligned offset, and an offset/length
range within the arena. The producer reserves the full aligned extent before
publishing it. No process-local pointers or file descriptors appear in frames.

IDs are carried without interpretation. Delivery scans pending slots in rotating
descending order and is not FIFO. Consumers must not infer publication order
from slot index or message ID.

## Publication and retirement

For each identity, availability is represented by parity:

```text
publication XOR retirement = 0  → free
publication XOR retirement = 1  → reserved or outstanding
```

Queue identities and region identities have independent parity and lifetimes.

### Producer reservation

For a buffer of at most 512 bytes, the producer reserves an unpublished queue
slot in its local reservation mask. The shared publication bit is unchanged.

The copy API, `try_send`, can initialize and publish a small buffer in one
operation without constructing an outgoing loan. It selects a slot with the
same exclusion of existing reservations, writes all descriptor fields and the
payload, then release-stores publication. A full queue returns false before
writing the slot. This direct path has no outstanding reservation to cancel.

For a larger buffer, the default `ArenaReclamation::eager` policy acquires region
retirement words, removes released extents, and chooses a contiguous aligned
range with sorted first-fit. This favors a compact working set.

The optional `ArenaReclamation::on_pressure` policy appends while known byte
capacity and a free region identity remain. It acquires region retirement only
on byte or identity pressure, then removes released extents and uses sorted
first-fit. Cached occupied extents can hide free space but cannot expose a live
region. Fewer remote observations can cost a larger memory working set; this
policy is not a universal performance default.

Both policies use a private table of at most 64 entries. Removing adjacent
extents merges free ranges implicitly; cancellation removes its own extent, so
cancelling the tail restores the append position. The selected identity's
publication parity is toggled and release-stored.

### Commit and cancellation

The producer initializes every byte the consumer will read, writes the
corresponding descriptor, then release-stores the toggled queue publication mask.
A successful commit disowns the outgoing handle. A failed commit leaves the loan
owned and unchanged for retry; this occurs when an arena loan has no descriptor
slot available.

Cancellation releases an unpublished inline reservation locally. Cancelling an
arena reservation removes its extent and restores the producer's previous region
publication parity. It never writes the consumer's retirement mask. This is safe
because no descriptor for that loan was published. A committed loan cannot be
cancelled through its disowned producer handle.

### Consume and release

An individual receive acquire-loads queue publication and computes pending bits
against the local retirement mask. An explicit drain reuses an acquired snapshot
across its ready set; delivered lanes are removed locally and a reused generation
requires a later acquire. Scalar receive retains its rotating descending scan;
the explicit drain uses a bounded bit scan to skip holes. The scalar hot path is
kept separate so snapshot bookkeeping does not burden individual receives.
Invalid storage kinds, lengths, offsets or region identities throw before
retiring that frame.

An inline loan retains its queue bit until release. The receiver masks retained
inline loans out of subsequent receive attempts, preventing duplicate delivery.
Release toggles the receiver-private retirement shadow and release-stores it.
Outside an explicit drain scope the store is immediate.

For an arena loan, the consumer retires the descriptor slot immediately after
copying the descriptor. The payload region stays live. Releasing that loan
toggles its region retirement bit in a receiver-private shadow and release-stores
the resulting word. There is one receiving/releasing thread per endpoint; an
atomic read-modify-write is unnecessary. The producer can reuse the descriptor
slot while the consumer still holds the payload bytes.

The producer acquire-loads acknowledgements before reuse. A cached queue
retirement mask is refreshed only when no known-free slots remain. Under this
single-producer/single-consumer protocol, staleness can hide newly freed slots
but cannot make an outstanding slot appear free.

### Open-set drain

`Receiver::drain(handler)` acquires a currently ready snapshot if needed, then
delivers its loans without waiting for a predetermined count or future arrivals.
The handler may move a loan into application storage and release it later on the
same endpoint thread. It must not recursively receive/drain this endpoint.

Within the drain scope, queue and region retirement toggles accumulate privately.
The outermost scope exit release-stores each changed retirement word once,
including on exception unwinding. Retained loans are excluded: only accesses
that have actually finished may be retired. Releases outside the scope retain
the immediate-store behavior. Deferred state can hide freed capacity, never
invent it; the mapping ABI and parity rules are unchanged.

A callback that waits on the peer must call `flush_retirements()` before blocking
or retrying after backpressure. This publishes finished accesses and avoids a
circular wait on hidden capacity. It never retires a still-owned loan. Deferred
scope destruction flushes any remaining dirty words before returning to idle.

### Required ordering

| Producer/consumer action | Synchronization edge |
| --- | --- |
| Header/lane initialization → attachment | ready release-store → acquire-load |
| Payload and descriptor writes → payload reads | queue publication release-store → acquire-load |
| Final inline reads → slot overwrite | queue retirement release-store → acquire-load |
| Final arena reads → region overwrite | region retirement release-store → acquire-load |

Exactly one release is permitted for each committed generation. A duplicate XOR
could restore equality while a newer generation is live. Move-only loans,
idempotent release, and exclusive endpoint ownership enforce this in the API.
The producer must observe release before recycling the identity.

## Backpressure and failure

The try APIs do not block, sleep, notify, or allocate heap memory per message.
An empty allocation result indicates insufficient inline slots, arena space,
contiguous space, region identities, or a request larger than the arena.
`try_send()` cancels its temporary loan if publication fails. No implicit retry
queue is created. Waiting and notification are caller responsibilities.

Byte access after commit, cancellation or release throws through the handle;
previously obtained spans are the caller's responsibility. ID/storage metadata
remain readable after release. Uninitialized bytes are not zero-filled.

Mappings and peers are trusted. Descriptor checks do not make a writable shared
mapping a security boundary. Peer failure or an abandoned loan can retain
capacity indefinitely. Stop both endpoints and replace the channel before
recovery; there is no live endpoint reconstruction, crash reclamation, replay,
or message deduplication protocol.
