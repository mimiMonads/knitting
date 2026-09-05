/**
 * Two questions this answers:
 *
 * 1. **Detection.** When a value reaches the encoder, how expensive is it to
 *    decide "this is backed by a pooled region, ship a descriptor"? The
 *    negative answer matters most: every ordinary `Uint8Array` in every
 *    payload pays it, and must not. Correctness of detection is covered by
 *    `test/knitting-buffer.test.ts`, not here.
 *
 * 2. **Transport.** At what payload size does shipping a descriptor beat
 *    copying the bytes into the payload arena, which is what the codec does
 *    today?
 *
 *   bun run bench/core/knitting-buffer-transport.ts
 *   deno run -A bench/core/knitting-buffer-transport.ts
 */

import { bench, do_not_optimize, group, run as mitataRun } from "mitata";
import {
  attachKnittingAllocator,
  createKnittingAllocator,
  detectRegion,
} from "../../src/memory/knitting-buffer.ts";
import { format, print } from "../util/json-parse.ts";

const KIB = 1024;
const ARENA = 32 * 1024 * KIB;

// ---------------------------------------------------------------------------
// Detection cost. The reject path is the one every payload pays.
// ---------------------------------------------------------------------------
group("detection (per encoded value)", () => {
  const pool = createKnittingAllocator({ slots: 128, arenaByteLength: ARENA });
  const region = pool.alloc(4 * KIB);
  const view = region.u8();
  const inner = view.subarray(64, 192);
  const heap = new Uint8Array(4 * KIB);
  const foreign = new Uint8Array(new SharedArrayBuffer(4 * KIB));

  bench("accept: region (instanceof)", () => {
    do_not_optimize(detectRegion(region));
  });
  bench("accept: minted view (WeakMap)", () => {
    do_not_optimize(detectRegion(view));
  });
  bench("accept: subarray (arena + binary search)", () => {
    do_not_optimize(detectRegion(inner));
  });
  bench("reject: heap Uint8Array", () => {
    do_not_optimize(detectRegion(heap));
  });
  bench("reject: unrelated SharedArrayBuffer", () => {
    do_not_optimize(detectRegion(foreign));
  });
  bench("reject: plain object", () => {
    do_not_optimize(detectRegion({ a: 1 }));
  });
  bench("reject: number", () => {
    do_not_optimize(detectRegion(42));
  });
});

// ---------------------------------------------------------------------------
// Transport: descriptor vs the copy the codec does today.
// ---------------------------------------------------------------------------
const SIZES = [1 * KIB, 8 * KIB, 64 * KIB, 256 * KIB, 1024 * KIB];

for (const size of SIZES) {
  const label = size >= 1024 * KIB ? `${size / 1024 / KIB} MiB` : `${size / KIB} KiB`;
  group(`transport ${label}`, () => {
    // No producer backstop: these loops hand every region to the consumer and
    // drop the producer handle, so the consumer's release is the only one.
    // A collector backstop here would be a second releaser for the same
    // identity -- see `moveTo()` for the shape real code should use.
    const producer = createKnittingAllocator({
      lane: 1,
      slots: 128,
      arenaByteLength: Math.max(ARENA, size * 4),
      gcBackstop: false,
    });
    const consumer = attachKnittingAllocator(producer.transport());

    // What the codec does today: the producer writes into its own buffer and
    // the transport copies those bytes into the shared payload arena, where
    // the consumer reads them.
    const payloadArena = new SharedArrayBuffer(size * 2);
    const payloadView = new Uint8Array(payloadArena, 0, size);
    const source = new Uint8Array(size);
    for (let i = 0; i < source.length; i++) source[i] = i & 0xff;

    bench("copy into the payload arena", () => {
      payloadView.set(source);
      const seen = new Uint8Array(payloadArena, 0, size);
      do_not_optimize(seen[0]! + seen[size - 1]!);
    });

    bench("descriptor (detect + adopt)", () => {
      const region = producer.alloc(size);
      const descriptor = detectRegion(region)!;
      const adopted = consumer.adopt(descriptor, { gcBackstop: false });
      const bytes = adopted.u8();
      do_not_optimize(bytes[0]! + bytes[size - 1]!);
      adopted.release();
    });

    // Producing straight into shared memory is the whole point: no source
    // buffer to copy from, the worker writes where the consumer will read.
    bench("descriptor + produce in place", () => {
      const region = producer.alloc(size);
      const out = region.u8();
      out[0] = 1;
      out[size - 1] = 2;
      const adopted = consumer.adopt(detectRegion(region)!, {
        gcBackstop: false,
      });
      const bytes = adopted.u8();
      do_not_optimize(bytes[0]! + bytes[size - 1]!);
      adopted.release();
    });
  });
}

await mitataRun({ format, print });
