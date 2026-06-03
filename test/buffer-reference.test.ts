import assert from "node:assert/strict";
import test from "./_runner.ts";
import {
  BufferReference,
  type BufferReferenceMetadata,
  isBufferReferenceMetadata,
} from "../unsafe.ts";
import { createPool } from "../knitting.ts";
import {
  storeBorrowedViewAndReturnLength,
  storedBorrowedViewByteLength,
  sumAndIncrement,
} from "./fixtures/buffer_reference_tasks.ts";

const transportFinalizer = Symbol.for(
  "knitting.payloadCodec.transportFinalizer",
);

const finishReference = (ref: BufferReference): void => {
  const finalizerFactory = (ref as unknown as Record<symbol, unknown>)[
    transportFinalizer
  ];
  const finalizer = typeof finalizerFactory === "function"
    ? (finalizerFactory as () => (() => void) | undefined).call(ref)
    : undefined;
  finalizer?.();
};

const supported = (() => {
  let ref: BufferReference | undefined;
  try {
    ref = new BufferReference(new Uint8Array(8));
    return ref.toUint8Array().byteLength === 8;
  } catch {
    return false;
  } finally {
    if (ref !== undefined) finishReference(ref);
  }
})();

const validMetadata = (): BufferReferenceMetadata => ({
  kind: "knitting.bufferReference",
  origin: "bun:1234",
  runtime: "bun",
  pointer: "140737488355328",
  byteLength: 8,
});

const isDetached = (buffer: ArrayBuffer): boolean =>
  (buffer as ArrayBuffer & { detached?: boolean }).detached === true ||
  buffer.byteLength === 0;

test("BufferReference captures a pointer and produces JSON-safe metadata", () => {
  if (!supported) return;

  const original = new Uint8Array([1, 2, 3, 4]);
  const ref = new BufferReference(original);
  try {
    assert.notEqual(ref.pointer, 0n);
    assert.equal(ref.byteLength, 4);
    assert.equal(ref.isLocal, true);

    const meta = ref.toMetadata();
    assert.equal(meta.kind, "knitting.bufferReference");
    assert.equal(typeof meta.pointer, "string");

    const roundTripped = JSON.parse(JSON.stringify(meta));
    assert.ok(isBufferReferenceMetadata(roundTripped));
  } finally {
    finishReference(ref);
  }
});

test("BufferReference.fromMetadata aliases the same memory", () => {
  if (!supported) return;

  const original = new Uint8Array([10, 20, 30]);
  const ref = new BufferReference(original);
  let consumer: BufferReference | undefined;
  try {
    const meta = ref.toMetadata();
    consumer = BufferReference.fromMetadata(meta);
    const view = consumer.toUint8Array();

    assert.deepEqual([...view], [10, 20, 30]);

    view[0] = 99;
    assert.equal(original[0], 99);
    original[2] = 123;
    assert.equal(view[2], 123);
  } finally {
    if (consumer !== undefined) finishReference(consumer);
    finishReference(ref);
  }
});

test("BufferReference rejects SharedArrayBuffer sources", () => {
  if (typeof SharedArrayBuffer !== "function") return;

  const sab = new SharedArrayBuffer(4);
  assert.throws(
    () => new BufferReference(sab as unknown as ArrayBuffer),
    /SharedArrayBuffer/,
  );
  assert.throws(
    () => new BufferReference(new Uint8Array(sab) as unknown as Uint8Array),
    /SharedArrayBuffer/,
  );
});

test("BufferReference accepts an ArrayBuffer and a typed-array view", () => {
  if (!supported) return;

  const buffer = new ArrayBuffer(4);
  new Uint8Array(buffer).set([5, 6, 7, 8]);

  const fromBuffer = new BufferReference(buffer);
  try {
    assert.equal(fromBuffer.byteLength, 4);
    assert.deepEqual([...fromBuffer.toUint8Array()], [5, 6, 7, 8]);

    const offsetView = new Uint8Array(buffer, 2, 2);
    const fromView = new BufferReference(offsetView);
    try {
      assert.equal(fromView.byteLength, 2);
      assert.deepEqual([...fromView.toUint8Array()], [7, 8]);
    } finally {
      finishReference(fromView);
    }
  } finally {
    finishReference(fromBuffer);
  }
});

test("BufferReference refuses to materialize across a process boundary", () => {
  if (!supported) return;

  const ref = new BufferReference(new Uint8Array([1, 2, 3]));
  try {
    const foreign = BufferReference.fromMetadata({
      ...ref.toMetadata(),
      origin: "node:999999",
    });

    assert.equal(foreign.isLocal, false);
    assert.throws(() => foreign.toArrayBuffer(), /process boundary/);
  } finally {
    finishReference(ref);
  }
});

test("transport finalizer drops the producer's hold on the source buffer", () => {
  if (!supported) return;

  const ref = new BufferReference(new Uint8Array([1, 2, 3]));
  finishReference(ref);
  assert.equal(ref.source, undefined);
  assert.throws(() => ref.toMetadata(), /released/);
  assert.throws(() => ref.toUint8Array(), /released/);
});

test("transport finalizer is idempotent", () => {
  if (!supported) return;

  const ref = new BufferReference(new Uint8Array([1, 2, 3]));
  const finalizerFactory = (ref as unknown as Record<symbol, unknown>)[
    transportFinalizer
  ];
  const finalizer = typeof finalizerFactory === "function"
    ? (finalizerFactory as () => (() => void) | undefined).call(ref)
    : undefined;
  finalizer?.();
  finalizer?.();
  assert.equal(ref.source, undefined);
});

test("transport finalizer detaches materialized borrowed buffers", () => {
  if (!supported) return;

  const ref = new BufferReference(new Uint8Array([1, 2, 3]));
  let consumer: BufferReference | undefined;
  try {
    consumer = BufferReference.fromMetadata(ref.toMetadata());
    const buffer = consumer.toArrayBuffer();
    assert.equal(buffer.byteLength, 3);

    if (
      consumer.runtime === "node" &&
      typeof (buffer as ArrayBuffer & { transfer?: unknown }).transfer ===
        "function"
    ) {
      assert.throws(
        () => (buffer as ArrayBuffer & { transfer: () => ArrayBuffer })
          .transfer(),
        /detach|transfer|ArrayBuffer/i,
      );
      assert.equal(buffer.byteLength, 3);
    }

    finishReference(consumer);
    assert.equal(isDetached(buffer), true);
  } finally {
    if (consumer !== undefined) finishReference(consumer);
    finishReference(ref);
  }
});

test("isBufferReferenceMetadata validates shape", () => {
  assert.equal(isBufferReferenceMetadata(null), false);
  assert.equal(isBufferReferenceMetadata({ kind: "nope" }), false);
  assert.equal(
    isBufferReferenceMetadata({ ...validMetadata(), pointer: 123 }),
    false,
  );
  assert.equal(
    isBufferReferenceMetadata({ ...validMetadata(), runtime: "wat" }),
    false,
  );
  assert.equal(isBufferReferenceMetadata(validMetadata()), true);
});

test("BufferReference flows through a thread pool with zero copy", async () => {
  if (!supported) return;

  const original = new Uint8Array([1, 2, 3, 4, 5]);
  const pool = createPool({ threads: 1 })({ sumAndIncrement });
  const ref = new BufferReference(original);

  try {
    const sum = await pool.call.sumAndIncrement(ref);

    assert.equal(sum, 15, "worker should see the host bytes");
    assert.deepEqual(
      [...original],
      [2, 3, 4, 5, 6],
      "host should see the worker's in-place writes (aliased, no copy)",
    );
  } finally {
    await pool.shutdown();
  }
  assert.throws(() => ref.toMetadata(), /released/);
});

test("worker-side materialized views are detached after task settlement", async () => {
  if (!supported) return;

  const original = new Uint8Array([1, 2, 3]);
  const pool = createPool({ threads: 1 })({
    storeBorrowedViewAndReturnLength,
    storedBorrowedViewByteLength,
  });

  try {
    const length = await pool.call.storeBorrowedViewAndReturnLength(
      new BufferReference(original),
    );
    assert.equal(length, 3);
    assert.equal(await pool.call.storedBorrowedViewByteLength(), 0);
  } finally {
    await pool.shutdown();
  }
});
