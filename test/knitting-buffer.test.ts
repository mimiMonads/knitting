import assert from "node:assert/strict";
import test from "./_runner.ts";
import {
  attachKnittingAllocator,
  createKnittingAllocator,
  detectByArena,
  detectByInstance,
  detectByMintedView,
  detectRegion,
  KnittingSharedBuffer,
} from "../src/memory/knitting-buffer.ts";

const supported = typeof SharedArrayBuffer === "function";
const KIB = 1024;

const runtimeGlobals = globalThis as unknown as {
  Bun?: { gc?: (force?: boolean) => void };
  gc?: () => void;
};
const collect: (() => void) | undefined = runtimeGlobals.Bun?.gc !== undefined
  ? () => runtimeGlobals.Bun!.gc!(true)
  : typeof runtimeGlobals.gc === "function"
  ? () => runtimeGlobals.gc!()
  : undefined;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("views are plain, memoized, and non-owning", () => {
  if (!supported) return;
  const pool = createKnittingAllocator({ slots: 64 });
  const region = pool.alloc(64);

  const bytes = region.u8();
  assert.equal(bytes.constructor, Uint8Array, "no subclass, no species games");
  assert.equal(region.u8(), bytes, "u8() is memoized, not reconstructed");
  assert.equal(region.view(Uint8Array), bytes, "view(Uint8Array) is the same");

  const f64 = region.view(Float64Array);
  assert.equal(f64.length, 8, "a 64-byte region is 8 float64 elements");
  assert.equal(region.view(Float64Array), f64, "typed views are memoized too");

  // The point of region-owns: an unrelated view does not orphan the others.
  bytes[0] = 0xff;
  assert.equal(new Uint8Array(f64.buffer, f64.byteOffset, 1)[0], 0xff);

  const copied = region.copy();
  region.release();
  assert.equal(copied[0], 0xff, "copy() survives release");
});

test("minting after release is refused, but a minted view is not revocable", () => {
  if (!supported) return;
  const pool = createKnittingAllocator({ slots: 64 });
  const region = pool.alloc(64);
  const escaped = region.u8();
  region.release();

  assert.equal(region.released, true);
  assert.throws(() => region.u8(), /released/);
  assert.throws(() => region.view(Float64Array), /released/);
  // The documented limit: a view minted before release still aliases the
  // region. JS cannot revoke it; `copy()` is the way to outlive the region.
  assert.equal(escaped.byteLength, 64);
});

test("a descriptor round trip hands the identity to the consumer", () => {
  if (!supported) return;
  const producer = createKnittingAllocator({ lane: 3, slots: 64 });
  const consumer = attachKnittingAllocator(producer.transport());

  const source = producer.alloc(4 * KIB);
  const sourceBytes = source.u8();
  for (let i = 0; i < sourceBytes.length; i++) sourceBytes[i] = (i * 7) & 0xff;

  const slotBeforeMove = source.slot;
  const descriptor = producer.moveTo(source);
  assert.equal(descriptor.kind, "region");
  assert.equal(source.moved, true, "the producer handle is spent");
  assert.throws(() => source.u8(), /moved to a consumer/);
  assert.throws(() => producer.moveTo(source), /already moved/);
  source.release();
  assert.equal(slotBeforeMove, descriptor.slot);

  const adopted = consumer.adopt(descriptor);
  assert.equal(adopted.byteLength, 4 * KIB);
  const adoptedBytes = adopted.u8();
  for (let i = 0; i < adoptedBytes.length; i++) {
    assert.equal(adoptedBytes[i], (i * 7) & 0xff);
  }

  // The producer handed ownership over, and its release() above was a no-op:
  // only the consumer's release may toggle the identity.
  const slot = slotBeforeMove;
  adopted.release();
  producer.reconcile();
  const next = producer.alloc(4 * KIB);
  assert.equal(next.slot, slot, "the consumer's release freed the identity");
  next.release();
});

test("identity exhaustion overflows to a SAB and never evicts a borrow", () => {
  if (!supported) return;
  const pool = createKnittingAllocator({ lane: 0, slots: 64 });
  const live: KnittingSharedBuffer[] = [];
  const seen = new Set<number>();

  for (let i = 0; i < 64; i++) {
    const region = pool.alloc(KIB);
    assert.notEqual(region.slot, -1, `alloc ${i} came from the pool`);
    assert.equal(seen.has(region.slot), false, "each identity is issued once");
    seen.add(region.slot);
    live.push(region);
  }

  const overflow = pool.alloc(KIB);
  assert.equal(overflow.slot, -1, "exhaustion falls back to a standalone SAB");
  assert.equal(pool.describe(overflow).kind, "buffer");
  assert.equal(
    live.every((region) => !region.released),
    true,
    "no live borrow was evicted to make room",
  );
  for (const region of live) region.release();
});

test("release is idempotent and does not strand the identity", () => {
  if (!supported) return;
  const pool = createKnittingAllocator({ slots: 64 });
  const region = pool.alloc(KIB);
  const slot = region.slot;

  region.release();
  region.release();
  region[Symbol.dispose]();

  pool.reconcile();
  const next = pool.alloc(KIB);
  assert.equal(next.slot, slot, "a repeated release did not toggle twice");
  next.release();
});

test("detection is exact on the accept and reject paths", () => {
  if (!supported) return;
  const pool = createKnittingAllocator({ lane: 7, slots: 128 });
  const region = pool.alloc(4 * KIB);
  const view = region.u8();

  assert.equal(detectByInstance(region), region);
  assert.equal(detectByInstance(view), undefined, "a view is not a region");
  assert.equal(detectByMintedView(view), region);

  const direct = detectRegion(region);
  assert.equal(direct?.kind, "region");
  assert.equal(direct?.kind === "region" && direct.slot, region.slot);
  assert.equal(direct?.kind === "region" && direct.lane, 7);
  assert.equal(detectRegion(view)?.kind, "region");

  // A subarray was never minted, but it is inside the arena.
  const inner = view.subarray(64, 192);
  assert.equal(detectByMintedView(inner), undefined);
  const innerDescriptor = detectByArena(inner);
  assert.equal(innerDescriptor?.kind, "region");
  assert.equal(
    innerDescriptor?.kind === "region" && innerDescriptor.slot,
    region.slot,
  );
  assert.equal(
    innerDescriptor?.kind === "region" && innerDescriptor.byteOffset,
    view.byteOffset + 64,
  );
  assert.equal(
    innerDescriptor?.kind === "region" && innerDescriptor.byteLength,
    128,
  );

  // A view that starts in a live region but runs past its extent.
  const second = pool.alloc(4 * KIB);
  const overrun = new Uint8Array(
    view.buffer as unknown as ArrayBufferLike,
    view.byteOffset,
    8 * KIB,
  );
  assert.equal(detectByArena(overrun), undefined, "an overrunning view rejects");
  second.release();

  // Impostors.
  assert.equal(detectRegion(new Uint8Array(4 * KIB)), undefined);
  assert.equal(detectRegion(new Uint8Array(new SharedArrayBuffer(64))), undefined);
  assert.equal(detectRegion("bytes"), undefined);
  assert.equal(detectRegion({ byteLength: 4096 }), undefined);
  assert.equal(detectRegion(undefined), undefined);

  // Another pool's arena resolves to that pool's lane, not this one.
  const other = createKnittingAllocator({ lane: 9, slots: 128 });
  const otherRegion = other.alloc(4 * KIB);
  const otherDescriptor = detectRegion(otherRegion.u8());
  assert.equal(otherDescriptor?.kind === "region" && otherDescriptor.lane, 9);

  region.release();
  otherRegion.release();
});

test("the collector reclaims forgotten identities", async () => {
  if (!supported || collect === undefined) return;
  const pool = createKnittingAllocator({ slots: 128 });
  const DROPPED = 100;

  // Allocate and drop every reference without releasing.
  ((): void => {
    for (let i = 0; i < DROPPED; i++) pool.alloc(4 * KIB);
  })();

  pool.reconcile();
  assert.equal(
    (pool.stats().tableLength as number) > 0,
    true,
    "identities are held before collection",
  );

  let recovered = 0;
  for (let attempt = 0; attempt < 20 && recovered < DROPPED; attempt++) {
    collect();
    await tick();
    pool.reconcile();
    recovered = DROPPED - (pool.stats().tableLength as number);
  }
  assert.equal(recovered, DROPPED, "every forgotten identity came back");
});

test("commit shrinks a region reserved for input of unknown length", () => {
  if (!supported) return;
  const pool = createKnittingAllocator({ slots: 64 });

  const region = pool.allocUpTo(64 * KIB);
  assert.equal(region.byteLength, 64 * KIB);

  const reserved = region.u8();
  reserved.set([1, 2, 3], 0);

  const committed = region.commit(3);
  assert.equal(committed, region, "commit returns the region");
  assert.equal(region.byteLength, 3, "the region reports the committed size");

  const bytes = region.u8();
  assert.equal(bytes.byteLength, 3, "views minted after commit are trimmed");
  assert.notEqual(bytes, reserved, "the stale view was dropped");
  assert.deepEqual([...bytes], [1, 2, 3], "the committed bytes survive");

  assert.equal(pool.describe(region).byteLength, 3, "the descriptor agrees");

  // Shrink only: growing would mean relocating the bytes.
  assert.throws(() => region.commit(64 * KIB), /between 0 and the reserved/);
  assert.throws(() => region.commit(-1), /between 0 and the reserved/);
  region.release();
});

test("a committed tail is handed back to the allocator", () => {
  if (!supported) return;
  const pool = createKnittingAllocator({ slots: 64, arenaByteLength: 64 * KIB });

  // Reserve most of the window, commit almost nothing, and the space must be
  // available again -- otherwise an upper-bound reservation would exhaust the
  // arena after a handful of requests.
  for (let i = 0; i < 32; i++) {
    const region = pool.allocUpTo(32 * KIB);
    assert.notEqual(region.slot, -1, `reservation ${i} came from the pool`);
    region.u8()[0] = i;
    region.commit(64);
    assert.equal(region.u8()[0], i, "the committed bytes are still there");
    region.release();
    pool.reconcile();
  }
});

test("regions are not constructible by hand", () => {
  if (!supported) return;
  const Region = KnittingSharedBuffer as unknown as new (
    ...args: unknown[]
  ) => unknown;

  // Fabricating a region would mean choosing its identity, and releasing it
  // would XOR an identity the caller does not own.
  assert.throws(
    () => new Region(new SharedArrayBuffer(64), 0, 64, 0, 3),
    /not constructible/,
  );
  assert.throws(
    () => new Region(Symbol("mint"), new SharedArrayBuffer(64), 0, 64, 0, 3),
    /not constructible/,
  );
});

test("the raw identity toggle is not exposed", () => {
  if (!supported) return;
  const allocator = createKnittingAllocator({ slots: 64 });
  const lane = attachKnittingAllocator(allocator.transport());

  // `free(slot)` with no ownership check would let a stray call make a live
  // identity look released, handing the same bytes out twice.
  assert.equal(
    (allocator as unknown as { free?: unknown }).free,
    undefined,
    "the allocator does not expose free",
  );
  assert.equal(
    (lane as unknown as { free?: unknown }).free,
    undefined,
    "an attached lane does not expose free",
  );
});

test("adopt rejects a descriptor that does not fit the arena", () => {
  if (!supported) return;
  const allocator = createKnittingAllocator({ slots: 64, arenaByteLength: 64 * KIB });
  const lane = attachKnittingAllocator(allocator.transport());

  const region = allocator.alloc(4 * KIB);
  const good = allocator.describe(region);
  assert.equal(lane.adopt(good).byteLength, 4 * KIB, "a real descriptor works");

  const forge = (patch: Record<string, unknown>) => ({ ...good, ...patch });

  assert.throws(() => lane.adopt(forge({ byteOffset: 64 * KIB }) as never), /outside the/);
  assert.throws(() => lane.adopt(forge({ byteLength: 128 * KIB }) as never), /outside the/);
  assert.throws(() => lane.adopt(forge({ byteOffset: -1 }) as never), /outside the/);
  assert.throws(() => lane.adopt(forge({ byteOffset: 1.5 }) as never), /outside the/);
  assert.throws(() => lane.adopt(forge({ slot: 64 }) as never), /outside 0\.\.63/);
  assert.throws(() => lane.adopt(forge({ slot: -1 }) as never), /outside 0\.\.63/);
  assert.throws(() => lane.adopt(forge({ lane: 99 }) as never), /adopted on lane/);

  region.release();
});

test("adopt rejects a 'buffer' descriptor whose buffer did not survive", () => {
  if (!supported) return;
  const allocator = createKnittingAllocator({
    slots: 32,
    arenaByteLength: 4 * KIB,
  });
  const lane = attachKnittingAllocator(allocator.transport());

  // Larger than the bump window, so this takes the overflow path.
  const overflow = allocator.alloc(8 * KIB);
  assert.equal(overflow.slot, -1, "this is a standalone region");

  const descriptor = allocator.describe(overflow);
  assert.equal(descriptor.kind, "buffer");
  assert.equal(lane.adopt(descriptor).byteLength, 8 * KIB, "same isolate is fine");

  // JSON.stringify is what knitting does to a plain-object payload, and it
  // renders a nested buffer as `{}`. Adopting that used to hand back a region
  // over the wrong memory, silently.
  const overWire = JSON.parse(JSON.stringify(descriptor));
  assert.deepEqual(overWire.buffer, {}, "the buffer really is flattened");
  assert.throws(
    () => lane.adopt(overWire),
    /carries no buffer/,
    "a flattened buffer is refused, not adopted",
  );

  assert.throws(
    () => lane.adopt({ ...descriptor, byteLength: 16 * KIB }),
    /claims 16384 bytes of a 8192-byte buffer/,
    "a descriptor may not claim more than its buffer holds",
  );
});

test("a standalone buffer can be adopted on its own", () => {
  if (!supported) return;
  const allocator = createKnittingAllocator({
    slots: 32,
    arenaByteLength: 4 * KIB,
  });
  const lane = attachKnittingAllocator(allocator.transport());

  const pooled = allocator.alloc(64);
  const overflow = allocator.alloc(8 * KIB);
  overflow.u8().fill(7);

  // This is how an overflow region crosses a thread: the buffer travels as the
  // payload itself, which is the one shape knitting preserves.
  const buffer = KnittingSharedBuffer.standaloneBufferOf(overflow)!;
  const adopted = lane.adopt(buffer);
  assert.equal(adopted.byteLength, 8 * KIB);
  assert.equal(adopted.slot, -1, "it carries no identity to release");
  assert.equal(adopted.u8()[0], 7, "and it is the same memory");

  // Releasing it must not XOR an identity it does not own. Identity 0 belongs
  // to `pooled`; if the release had touched it, the next allocation would
  // hand it straight back.
  adopted.release();
  allocator.reconcile();
  assert.notEqual(
    allocator.alloc(64).slot,
    pooled.slot,
    "the pooled identity is still held",
  );
});

test("an oversized request overflows instead of wrapping the arena", () => {
  if (!supported) return;
  const allocator = createKnittingAllocator({
    slots: 32,
    arenaByteLength: 64 * KIB,
  });

  // 2 GiB used to survive `byteLength | 0` as a negative aligned size, pass
  // the arena bound, and leave tailEnd negative for the life of the pool.
  const huge = allocator.alloc(2 * 1024 * 1024 * 1024);
  assert.equal(huge.slot, -1, "it takes the standalone valve, not a region");
  assert.equal(allocator.stats().overflows, 1);
  huge.release();

  // The pool still allocates normally afterwards.
  const after = allocator.alloc(128);
  assert.notEqual(after.slot, -1, "the arena survived the oversized request");
  assert.ok(after.byteOffset >= 0 && allocator.stats().tailEnd > 0);
});

test("identities do not alias when slots is not a power of two", () => {
  if (!supported) return;
  const allocator = createKnittingAllocator({
    slots: 96,
    arenaByteLength: 64 * KIB,
  });

  // Hold every identity in the first word so the next one lands at slot 32,
  // which `slot & (slots - 1)` folded onto slot 0.
  const held: Array<ReturnType<typeof allocator.alloc>> = [];
  for (let i = 0; i < 33; i++) held.push(allocator.alloc(64));

  const starts = new Set<number>();
  for (const region of held) {
    assert.notEqual(region.slot, -1, "all 33 identities are pooled");
    assert.equal(starts.has(region.byteOffset), false, "no two share an offset");
    starts.add(region.byteOffset);
  }

  const slot32 = held.find((region) => region.slot === 32)!;
  const slot0 = held.find((region) => region.slot === 0)!;
  slot0.u8().fill(0xaa);
  slot32.u8().fill(0x11);
  assert.equal(slot0.u8()[0], 0xaa, "writing slot 32 did not land on slot 0");

  // And releasing slot 32 must not toggle slot 0's release bit.
  slot32.release();
  allocator.reconcile();
  const next = allocator.alloc(64);
  assert.notEqual(next.slot, slot0.slot, "slot 0 is still held");
});

test("the collector backstop decrements the live count it frees", async () => {
  if (!supported || collect === undefined) return;
  const allocator = createKnittingAllocator({ slots: 32 });

  for (let i = 0; i < 8; i++) allocator.alloc(64);
  assert.equal(allocator.stats().live, 8, "eight handles are outstanding");

  collect();
  await tick();
  collect();
  await tick();

  // Whatever the collector reclaimed must come off `live`; when it does not,
  // gcBackstop:"pressure" latches on permanently once past the watermark.
  const { live } = allocator.stats();
  allocator.reconcile();
  assert.ok(live < 8, `collected handles left live at ${live}`);
});

test("a moved region has exactly one releaser", () => {
  if (!supported) return;
  const producer = createKnittingAllocator({
    slots: 32,
    arenaByteLength: 64 * KIB,
    gcBackstop: false,
  });
  const consumer = attachKnittingAllocator(producer.transport());

  // Move region `a` out, then release it on the consumer side and let the
  // producer recycle the identity into a live region `b`.
  const a = producer.alloc(256);
  const movedA = consumer.adopt(producer.moveTo(a));
  movedA.release();
  producer.reconcile();

  const b = producer.alloc(256);
  assert.equal(b.slot, a.slot, "the identity was recycled into b");
  b.u8().fill(0xaa);

  // The producer's spent handle must not free b's identity from under it.
  // When it did, the next alloc handed back a region aliasing b's bytes.
  a.release();
  producer.reconcile();

  const c = producer.alloc(256);
  if (c.slot === b.slot) {
    c.u8().fill(0x11);
    assert.fail("the recycled identity aliased a live region");
  }
  assert.equal(b.u8()[0], 0xaa, "b still owns its bytes");
});

test("a borrowed adopt cannot release the producer's identity", () => {
  if (!supported) return;
  const producer = createKnittingAllocator({
    slots: 32,
    arenaByteLength: 64 * KIB,
    gcBackstop: false,
  });
  const consumer = attachKnittingAllocator(producer.transport());

  const region = producer.alloc(256);
  region.u8().fill(0x5a);

  // The producer stays the owner; the borrow is only good for the call.
  const borrowed = consumer.adopt(producer.describe(region), { borrow: true });
  assert.equal(borrowed.u8()[0], 0x5a);
  borrowed.release();

  // That release must not have toggled anything: the identity is still held.
  producer.reconcile();
  const next = producer.alloc(256);
  assert.notEqual(next.slot, region.slot, "the borrow did not free the region");

  // And the owner's release still works normally.
  region.release();
  producer.reconcile();
  assert.equal(producer.alloc(256).slot, region.slot);
});

test("describe refuses a region from another pool", () => {
  if (!supported) return;
  const a = createKnittingAllocator({ lane: 1, slots: 32 });
  const b = createKnittingAllocator({ lane: 2, slots: 32 });
  const foreign = b.alloc(64);
  assert.throws(() => a.describe(foreign), /lane 2, not lane 1/);
  assert.throws(() => a.moveTo(foreign), /lane 2, not lane 1/);
});
