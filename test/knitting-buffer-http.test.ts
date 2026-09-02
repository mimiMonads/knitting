import assert from "node:assert/strict";
import test from "./_runner.ts";
import {
  createKnittingAllocator,
  KnittingSharedBuffer,
} from "../src/memory/knitting-buffer.ts";
import { BufferReference } from "../unsafe.ts";
import { createPool } from "../knitting.ts";
import { sumAndIncrement } from "./fixtures/buffer_reference_tasks.ts";
import {
  HTTP_BODY_STREAM_THRESHOLD_BYTES,
  readBodyIntoBytes,
  readBodyIntoRegion,
} from "../src/memory/knitting-buffer-http.ts";

const MIB = 1024 * 1024;
/** Every helper that cannot infer a bound now insists the test states one. */
const LIMIT = { maxByteLength: 4 * MIB };

const supported = typeof SharedArrayBuffer === "function";
const KIB = 1024;

const bufferReferenceSupported = (() => {
  let reference: BufferReference | undefined;
  try {
    reference = new BufferReference(new Uint8Array(1));
    return reference.toUint8Array().byteLength === 1;
  } catch {
    return false;
  } finally {
    reference?.release();
  }
})();

const pattern = (bytes: number): Uint8Array => {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = (i * 31) & 0xff;
  return out;
};

/** A request whose body streams in `chunkSize` pieces. */
const streamingRequest = (
  body: Uint8Array,
  { chunkSize = 16 * KIB, contentLength = body.byteLength }: {
    chunkSize?: number;
    contentLength?: number | null;
  } = {},
): Request => {
  let at = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= body.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(at + chunkSize, body.byteLength);
      controller.enqueue(body.subarray(at, end));
      at = end;
    },
  });
  const headers = new Headers();
  if (contentLength !== null) {
    headers.set("content-length", String(contentLength));
  }
  return new Request("http://local/upload", {
    method: "POST",
    body: stream,
    headers,
    // @ts-ignore: required by undici/node for a stream body
    duplex: "half",
  });
};

test("a small body is materialized and copied", async () => {
  if (!supported) return;
  const pool = createKnittingAllocator({ slots: 64 });
  const body = pattern(4 * KIB);

  const region = await readBodyIntoRegion(streamingRequest(body), pool);
  assert.equal(region.byteLength, body.byteLength);
  assert.deepEqual([...region.u8()], [...body]);
  assert.notEqual(region.slot, -1, "it came from the pool");
  region.release();
});

test("allocOrRefer keeps a small request in the allocator", async () => {
  if (!supported) return;
  const allocator = createKnittingAllocator({ slots: 64 });
  const body = pattern(4 * KIB);

  const payload = await allocator.allocOrRefer(streamingRequest(body), {
    referenceAboveBytes: 64 * KIB,
    maxByteLength: MIB,
  });
  assert.ok(payload instanceof KnittingSharedBuffer);
  assert.deepEqual([...payload.u8()], [...body]);
  assert.equal(payload.slot >= 0, true, "small bodies use the arena");
  payload.release();
});

test("allocOrRefer moves a large request into BufferReference", async () => {
  if (!supported || !bufferReferenceSupported) return;
  const allocator = createKnittingAllocator({
    slots: 64,
    arenaByteLength: 256 * KIB,
  });
  const body = pattern(96 * KIB);

  const payload = await allocator.allocOrRefer(streamingRequest(body), {
    referenceAboveBytes: 64 * KIB,
    maxByteLength: MIB,
  });
  assert.ok(payload instanceof BufferReference);
  assert.deepEqual([...payload.toUint8Array()], [...body]);
  payload.release();
  assert.equal(allocator.stats().live, 0, "the reference path does not use the arena");
});

test("allocOrRefer chooses by actual size for chunked bodies", async () => {
  if (!supported || !bufferReferenceSupported) return;
  const allocator = createKnittingAllocator({ slots: 64 });
  const body = pattern(96 * KIB);

  const payload = await allocator.allocOrRefer(
    streamingRequest(body, { contentLength: null }),
    { referenceAboveBytes: 64 * KIB, maxByteLength: MIB },
  );
  assert.ok(payload instanceof BufferReference);
  assert.deepEqual([...payload.toUint8Array().subarray(0, 64)], [...body.subarray(0, 64)]);
  payload.release();
});

test("allocOrRefer's moved result round-trips through a thread worker", async () => {
  if (!supported || !bufferReferenceSupported) return;
  const allocator = createKnittingAllocator({ slots: 64 });
  const body = pattern(96 * KIB);
  const payload = await allocator.allocOrRefer(streamingRequest(body), {
    referenceAboveBytes: 64 * KIB,
    maxByteLength: MIB,
  });
  if (!(payload instanceof BufferReference)) {
    payload.release();
    assert.fail("the test body should take the BufferReference path");
  }

  const pool = createPool({ threads: 1 })({ sumAndIncrement });
  try {
    let expected = 0;
    for (const byte of body) expected += byte;
    assert.equal(await pool.call.sumAndIncrement(payload), expected);
  } finally {
    payload.release();
    await pool.shutdown();
  }
});

test("a body at or over the threshold streams into a preallocated region", async () => {
  if (!supported) return;
  const pool = createKnittingAllocator({
    slots: 64,
    arenaByteLength: 8 * 1024 * KIB,
  });
  const body = pattern(HTTP_BODY_STREAM_THRESHOLD_BYTES);

  const region = await readBodyIntoRegion(streamingRequest(body), pool);
  assert.equal(region.byteLength, body.byteLength);
  assert.deepEqual([...region.u8().subarray(0, 64)], [...body.subarray(0, 64)]);
  assert.deepEqual(
    [...region.u8().subarray(body.byteLength - 64)],
    [...body.subarray(body.byteLength - 64)],
  );
  region.release();
});

test("the threshold is configurable", async () => {
  if (!supported) return;
  const pool = createKnittingAllocator({ slots: 64 });
  const body = pattern(8 * KIB);

  // Forced onto the streaming path even though it is a small body.
  const region = await readBodyIntoRegion(streamingRequest(body), pool, {
    streamThresholdBytes: 1024,
  });
  assert.equal(region.byteLength, body.byteLength);
  assert.deepEqual([...region.u8()], [...body]);
  region.release();
});

test("a body with no Content-Length is materialized whatever its size", async () => {
  if (!supported) return;
  const pool = createKnittingAllocator({
    slots: 64,
    arenaByteLength: 8 * 1024 * KIB,
  });
  const body = pattern(HTTP_BODY_STREAM_THRESHOLD_BYTES + 7);

  const region = await readBodyIntoRegion(
    streamingRequest(body, { contentLength: null }),
    pool,
  );
  assert.equal(region.byteLength, body.byteLength, "the real length is used");
  assert.deepEqual(
    [...region.u8().subarray(0, 128)],
    [...body.subarray(0, 128)],
  );
  region.release();
});

test("a body shorter than it claimed commits the tail back", async () => {
  if (!supported) return;
  const pool = createKnittingAllocator({
    slots: 64,
    arenaByteLength: 8 * 1024 * KIB,
  });
  const body = pattern(HTTP_BODY_STREAM_THRESHOLD_BYTES);

  const region = await readBodyIntoRegion(
    // Claims 64 KiB more than it sends.
    streamingRequest(body, { contentLength: body.byteLength + 64 * KIB }),
    pool,
  );
  assert.equal(
    region.byteLength,
    body.byteLength,
    "the region reports what arrived, not what was claimed",
  );
  assert.equal(region.u8().byteLength, body.byteLength);
  region.release();
});

test("a body longer than it claimed is rejected, not written past", async () => {
  if (!supported) return;
  const pool = createKnittingAllocator({
    slots: 64,
    arenaByteLength: 8 * 1024 * KIB,
  });
  const body = pattern(HTTP_BODY_STREAM_THRESHOLD_BYTES + 128 * KIB);
  const declared = HTTP_BODY_STREAM_THRESHOLD_BYTES;

  // A neighbouring region must survive the overrun attempt intact.
  const neighbour = pool.alloc(4 * KIB);
  neighbour.u8().fill(0xab);

  await assert.rejects(
    () =>
      readBodyIntoRegion(
        streamingRequest(body, { contentLength: declared }),
        pool,
      ),
    /exceeds its declared/,
  );
  assert.equal(
    neighbour.u8().every((byte) => byte === 0xab),
    true,
    "the overrun did not reach the neighbouring region",
  );
  neighbour.release();
});

test("a rejected body does not strand its identity", async () => {
  if (!supported) return;
  const pool = createKnittingAllocator({
    slots: 64,
    arenaByteLength: 8 * 1024 * KIB,
  });
  const declared = HTTP_BODY_STREAM_THRESHOLD_BYTES;
  const body = pattern(declared + 64 * KIB);

  const before = pool.stats().live as number;
  await assert.rejects(() =>
    readBodyIntoRegion(streamingRequest(body, { contentLength: declared }), pool)
  );
  assert.equal(
    pool.stats().live as number,
    before,
    "the region was released on the failure path",
  );
});

test("maxByteLength rejects an oversized claim before allocating", async () => {
  if (!supported) return;
  const pool = createKnittingAllocator({ slots: 64 });
  const body = pattern(4 * KIB);

  await assert.rejects(
    () =>
      readBodyIntoRegion(streamingRequest(body), pool, {
        maxByteLength: 1024,
      }),
    /over the 1024 limit/,
  );
  assert.equal(pool.stats().live as number, 0, "nothing was allocated");
});

test("readBodyIntoBytes writes into any caller-supplied allocation", async () => {
  if (!supported) return;
  // Stands in for pool.sharedArgBytes: hands back a slice of an arena the
  // caller owns, so the transport can ship an offset instead of the bytes.
  const arena = new Uint8Array(4 * 1024 * KIB);
  let at = 0;
  const allocate = (n: number): Uint8Array => {
    const view = arena.subarray(at, at + n);
    at += n;
    return view;
  };

  const small = pattern(4 * KIB);
  const viaCopy = await readBodyIntoBytes(streamingRequest(small), allocate, LIMIT);
  assert.deepEqual([...viaCopy], [...small], "the materialized path lands in the arena");
  assert.equal(viaCopy.buffer, arena.buffer, "it really is the caller's memory");

  const big = pattern(HTTP_BODY_STREAM_THRESHOLD_BYTES);
  const viaStream = await readBodyIntoBytes(streamingRequest(big), allocate, LIMIT);
  assert.equal(viaStream.byteLength, big.byteLength);
  assert.deepEqual([...viaStream.subarray(0, 64)], [...big.subarray(0, 64)]);
  assert.equal(viaStream.buffer, arena.buffer, "the streamed path too");
});

test("readBodyIntoBytes trims a body shorter than it claimed", async () => {
  if (!supported) return;
  const body = pattern(HTTP_BODY_STREAM_THRESHOLD_BYTES);
  const out = await readBodyIntoBytes(
    streamingRequest(body, { contentLength: body.byteLength + 4 * KIB }),
    (n) => new Uint8Array(n),
    LIMIT,
  );
  assert.equal(out.byteLength, body.byteLength, "it reports what arrived");
});

test("readBodyIntoBytes rejects a body longer than it claimed", async () => {
  if (!supported) return;
  const declared = HTTP_BODY_STREAM_THRESHOLD_BYTES;
  const body = pattern(declared + 8 * KIB);
  await assert.rejects(
    () =>
      readBodyIntoBytes(
        streamingRequest(body, { contentLength: declared }),
        (n) => new Uint8Array(n),
        LIMIT,
      ),
    /exceeds its declared/,
  );
});

test("a declared length larger than the arena is refused by default", async () => {
  if (!supported) return;
  const pool = createKnittingAllocator({
    slots: 32,
    arenaByteLength: 256 * KIB,
  });

  // No body is sent at all: the claim alone used to commit the memory, since
  // the default cap was Infinity and an oversized region falls through to a
  // standalone SharedArrayBuffer of exactly the declared size.
  await assert.rejects(
    () =>
      readBodyIntoRegion(
        streamingRequest(pattern(KIB), { contentLength: 512 * MIB }),
        pool,
      ),
    /over the .* limit/,
  );
  assert.equal(pool.stats().overflows, 0, "nothing was allocated for it");
  assert.equal(pool.stats().pooled, 0);
});

test("the default cap is the arena, and is still overridable", async () => {
  if (!supported) return;
  const pool = createKnittingAllocator({
    slots: 32,
    arenaByteLength: 256 * KIB,
  });
  assert.equal(pool.arenaByteLength, 256 * KIB);

  // A body that fits the arena is unaffected by the new default.
  const body = pattern(200 * KIB);
  const region = await readBodyIntoRegion(streamingRequest(body), pool);
  assert.equal(region.byteLength, body.byteLength);
  region.release();

  // And a caller who really wants a larger body says so.
  const big = pattern(400 * KIB);
  const overflowed = await readBodyIntoRegion(streamingRequest(big), pool, {
    maxByteLength: MIB,
  });
  assert.equal(overflowed.byteLength, big.byteLength);
  assert.deepEqual([...overflowed.u8().subarray(0, 64)], [...big.subarray(0, 64)]);
  overflowed.release();
});

test("a body that declares no length is read against the cap", async () => {
  if (!supported) return;
  const pool = createKnittingAllocator({
    slots: 32,
    arenaByteLength: 256 * KIB,
  });

  // Omitting Content-Length used to route around the cap entirely: the body
  // was buffered whole and only then measured.
  await assert.rejects(
    () =>
      readBodyIntoRegion(
        streamingRequest(pattern(200 * KIB), { contentLength: null }),
        pool,
        { maxByteLength: 64 * KIB },
      ),
    /over the 65536 byte limit/,
  );

  // An undeclared body under the cap still arrives intact.
  const body = pattern(32 * KIB);
  const region = await readBodyIntoRegion(
    streamingRequest(body, { contentLength: null }),
    pool,
    { maxByteLength: 64 * KIB },
  );
  assert.deepEqual([...region.u8()], [...body]);
  region.release();
});
