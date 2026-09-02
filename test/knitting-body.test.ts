import assert from "node:assert/strict";
import test from "./_runner.ts";
import { createKnittingAllocator } from "../src/memory/knitting-buffer.ts";
import { createPool } from "../knitting.ts";
import { digestBody } from "./fixtures/knitting_body_tasks.ts";
import { isBufferReferenceValue } from "../src/connections/buffer-reference.ts";

const supported = typeof SharedArrayBuffer === "function";
const KIB = 1024;
const MIB = 1024 * KIB;

const pattern = (bytes: number): Uint8Array => {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = (i * 31) & 0xff;
  return out;
};

const digestOf = (bytes: Uint8Array): number => {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i]!) & 0xffffff;
  return (sum << 8) | (bytes.byteLength & 0xff);
};

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
  return new Request("http://localhost/body", {
    method: "POST",
    body: stream,
    headers,
    // @ts-ignore: required by undici for a streaming body.
    duplex: "half",
  });
};

/**
 * The three transports a body can take, through one task.
 *
 * Sizes are chosen against a 256 KiB arena and a 512 KiB reference threshold:
 * pooled sits inside the arena, overflow is larger than the bump window but
 * under the threshold, and moved is over it.
 */
const CASES = [
  { name: "pooled region", bytes: 64 * KIB, wire: "descriptor" },
  { name: "overflow buffer", bytes: 384 * KIB, wire: "buffer" },
  { name: "moved reference", bytes: 640 * KIB, wire: "reference" },
] as const;

/** Which transport a wire value actually is, so the cases cannot all collapse
 * onto the same path and quietly prove nothing. */
const wireKind = (wire: unknown): string => {
  if (isBufferReferenceValue(wire)) return "reference";
  if (
    wire instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer === "function" &&
      wire instanceof SharedArrayBuffer)
  ) {
    return "buffer";
  }
  return "descriptor";
};

test("one task reads a body whichever way it travelled", async () => {
  if (!supported) return;
  const allocator = createKnittingAllocator({
    slots: 64,
    arenaByteLength: 256 * KIB,
  });
  const pool = createPool({
    threads: 1,
    worker: {
      bootstrap: {
        href: "./fixtures/knitting_body_bootstrap.ts",
        name: "setup",
        data: allocator.transport(),
      },
    },
  })({ digestBody });

  try {
    for (const { name, bytes, wire } of CASES) {
      const body = pattern(bytes);
      using handle = await allocator.readBody(streamingRequest(body), {
        referenceAboveBytes: 512 * KIB,
        maxByteLength: 4 * MIB,
      });

      assert.equal(wireKind(handle.wire), wire, `${name}: took its own path`);
      assert.equal(handle.byteLength, bytes, `${name}: length`);
      assert.deepEqual([...handle.u8().subarray(0, 32)], [...body.subarray(0, 32)], `${name}: host bytes`);
      assert.equal(
        await pool.call.digestBody(handle.wire),
        digestOf(body),
        `${name}: the worker saw the same bytes`,
      );
    }
  } finally {
    await pool.shutdown();
  }
});

test("a body shorter than it claimed still travels at its real length", async () => {
  if (!supported) return;
  const allocator = createKnittingAllocator({
    slots: 64,
    arenaByteLength: 256 * KIB,
  });
  const pool = createPool({
    threads: 1,
    worker: {
      bootstrap: {
        href: "./fixtures/knitting_body_bootstrap.ts",
        name: "setup",
        data: allocator.transport(),
      },
    },
  })({ digestBody });

  try {
    // Declares more than it sends, and is too large for the arena, so it takes
    // the standalone buffer -- which was sized to the claim, not the body.
    const body = pattern(300 * KIB);
    using handle = await allocator.readBody(
      streamingRequest(body, { contentLength: 384 * KIB }),
      { referenceAboveBytes: 512 * KIB, maxByteLength: 4 * MIB },
    );

    assert.equal(wireKind(handle.wire), "buffer", "it took the standalone path");
    assert.equal(handle.byteLength, body.byteLength, "the host reports what arrived");
    assert.equal(
      await pool.call.digestBody(handle.wire),
      digestOf(body),
      "and the worker does not see the unwritten tail",
    );
  } finally {
    await pool.shutdown();
  }
});

test("the host owns the body and reclaims the identity after the call", async () => {
  if (!supported) return;
  const allocator = createKnittingAllocator({
    slots: 32,
    arenaByteLength: 256 * KIB,
  });
  const pool = createPool({
    threads: 1,
    worker: {
      bootstrap: {
        href: "./fixtures/knitting_body_bootstrap.ts",
        name: "setup",
        data: allocator.transport(),
      },
    },
  })({ digestBody });

  try {
    // Far more bodies than there are identities: if the worker's borrow
    // released, or the host's dispose did not, this runs out and overflows.
    for (let i = 0; i < 200; i++) {
      const body = pattern(4 * KIB);
      using handle = await allocator.readBody(streamingRequest(body), {
        referenceAboveBytes: 512 * KIB,
        maxByteLength: 4 * MIB,
      });
      assert.equal(await pool.call.digestBody(handle.wire), digestOf(body));
    }
    assert.equal(
      allocator.stats().overflows,
      0,
      "identities were reclaimed without an explicit reconcile()",
    );
  } finally {
    await pool.shutdown();
  }
});
