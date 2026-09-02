/**
 * What `KnittingSharedBuffer` costs per allocation, what minting views costs,
 * and what the escape valve costs.
 *
 *   pooled + gc backstop   alloc, FinalizationRegistry register, release,
 *                          unregister -- the shape real user code gets
 *   pooled + pressure      the backstop only once identities get scarce
 *   pooled, no backstop    no collector safety net at all
 *   overflow SAB           the identity-exhausted fallback path
 *   new Uint8Array         ordinary heap allocation, for scale
 *   raw region             registry alloc + free with no handle: the floor
 *
 *   bun run bench/core/knitting-buffer.bench.ts
 *   deno run -A bench/core/knitting-buffer.bench.ts
 */

import { bench, do_not_optimize, group, run as mitataRun } from "mitata";
import {
  attachKnittingAllocator,
  createKnittingAllocator,
} from "../../src/memory/knitting-buffer.ts";
import { createLazyRegionRegistry } from "../../src/memory/lazy-region-registry.ts";
import { format, print } from "../util/json-parse.ts";

const KIB = 1024;
const ARENA = 32 * 1024 * KIB;
const SIZES = [4 * KIB, 256 * KIB];

for (const size of SIZES) {
  group(`KnittingSharedBuffer alloc + u8 + release (${size / KIB} KiB)`, () => {
    const backstop = createKnittingAllocator({
      slots: 128,
      arenaByteLength: ARENA,
      gcBackstop: true,
    });
    bench("pooled + gc backstop", () => {
      const region = backstop.alloc(size);
      do_not_optimize(region.u8().byteOffset);
      region.release();
    });

    const pressure = createKnittingAllocator({
      slots: 128,
      arenaByteLength: ARENA,
      gcBackstop: "pressure",
    });
    bench("pooled + backstop under pressure only", () => {
      const region = pressure.alloc(size);
      do_not_optimize(region.u8().byteOffset);
      region.release();
    });

    const bare = createKnittingAllocator({
      slots: 128,
      arenaByteLength: ARENA,
      gcBackstop: false,
    });
    bench("pooled, no backstop", () => {
      const region = bare.alloc(size);
      do_not_optimize(region.u8().byteOffset);
      region.release();
    });

    // Identity space kept full so every allocation takes the fallback.
    const full = createKnittingAllocator({
      slots: 32,
      arenaByteLength: 64 * KIB,
      gcBackstop: true,
    });
    const pinned = Array.from({ length: 32 }, () => full.alloc(64));
    do_not_optimize(pinned.length);
    bench("overflow SAB", () => {
      const region = full.alloc(size);
      do_not_optimize(region.u8().byteLength);
      region.release();
    });

    bench("new Uint8Array", () => {
      do_not_optimize(new Uint8Array(size).byteLength);
    });

    const raw = createLazyRegionRegistry({
      slots: 128,
      mode: "lazy",
      arenaByteLength: ARENA,
    });
    bench("raw region (no handle)", () => {
      const slot = raw.allocRegion(size);
      do_not_optimize(slot);
      raw.free(slot);
    });
  });
}

// Minting is the ergonomic cost of the region-owns shape: one call per use
// site instead of the region being the array. Memoization is what makes that
// a call and not a construction.
group("view minting (4 KiB region)", () => {
  const pool = createKnittingAllocator({ slots: 128, arenaByteLength: ARENA });
  const region = pool.alloc(4 * KIB);
  region.u8();
  region.view(Float64Array);

  bench("region.u8() memoized", () => {
    do_not_optimize(region.u8().byteOffset);
  });
  bench("region.view(Float64Array) memoized", () => {
    do_not_optimize(region.view(Float64Array).byteOffset);
  });

  const arena = new SharedArrayBuffer(ARENA);
  let offset = 0;
  bench("new Uint8Array(sab, off, len) each time", () => {
    offset = (offset + 4 * KIB) & (ARENA - 1);
    do_not_optimize(new Uint8Array(arena, offset, 4 * KIB).byteOffset);
  });
});

group("KnittingSharedBuffer descriptor round trip (4 KiB)", () => {
  const producer = createKnittingAllocator({
    lane: 1,
    slots: 128,
    arenaByteLength: ARENA,
  });
  const consumer = attachKnittingAllocator(producer.transport());

  bench("alloc + moveTo + adopt + release", () => {
    const region = producer.alloc(4 * KIB);
    const adopted = consumer.adopt(producer.moveTo(region));
    do_not_optimize(adopted.u8().byteLength);
    adopted.release();
  });

  const bareProducer = createKnittingAllocator({
    lane: 2,
    slots: 128,
    arenaByteLength: ARENA,
    gcBackstop: false,
  });
  const bareConsumer = attachKnittingAllocator(bareProducer.transport());
  bench("the same, no gc backstop", () => {
    const region = bareProducer.alloc(4 * KIB);
    const adopted = bareConsumer.adopt(bareProducer.moveTo(region), {
      gcBackstop: false,
    });
    do_not_optimize(adopted.u8().byteLength);
    adopted.release();
  });
});

await mitataRun({ format, print });
