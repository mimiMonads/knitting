import assert from "node:assert/strict";
import test from "./_runner.ts";
import {
  BufferReference,
  type BufferReferenceMetadata,
  isBufferReferenceMetadata,
} from "../unsafe.ts";
import { createPool } from "../knitting.ts";
import { withBufferReferenceReturnReleaser } from "../src/connections/buffer-reference.ts";
import {
  echoBufferPlusOne,
  returnsBuffer,
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
  token: "1",
  byteOffset: 0,
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

test("BufferReference.fromMetadata materializes the moved bytes", () => {
  if (!supported) return;

  const original = new Uint8Array([10, 20, 30]);
  const ref = new BufferReference(original);
  let a: BufferReference | undefined;
  let b: BufferReference | undefined;
  try {
    assert.equal(original.byteLength, 0, "source is detached by the move");

    const meta = ref.toMetadata();
    a = BufferReference.fromMetadata(meta);
    b = BufferReference.fromMetadata(meta);
    const av = a.toUint8Array();
    const bv = b.toUint8Array();

    assert.deepEqual([...av], [10, 20, 30]);

    av[0] = 99;
    assert.equal(bv[0], 99);
    bv[2] = 123;
    assert.equal(av[2], 123);
  } finally {
    if (a !== undefined) finishReference(a);
    if (b !== undefined) finishReference(b);
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
  } finally {
    finishReference(fromBuffer);
  }

  const backing = new Uint8Array([1, 2, 3, 4]);
  const offsetView = new Uint8Array(backing.buffer, 2, 2);
  const fromView = new BufferReference(offsetView);
  try {
    assert.equal(fromView.byteLength, 2);
    assert.deepEqual([...fromView.toUint8Array()], [3, 4]);
  } finally {
    finishReference(fromView);
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

test("BufferReference flows through a thread pool (move semantics)", async () => {
  if (!supported) return;

  const original = new Uint8Array([1, 2, 3, 4, 5]);
  const pool = createPool({ threads: 1 })({ sumAndIncrement });
  const ref = new BufferReference(original);

  try {
    const sum = await pool.call.sumAndIncrement(ref);

    assert.equal(sum, 15, "worker should see the moved host bytes");
    // In-place worker writes do not update the detached source handle.
    assert.equal(original.byteLength, 0, "source is detached by the move");
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

test("worker returns a BufferReference moved back to the host", async () => {
  if (!supported) return;

  const pool = createPool({ threads: 1 })({ returnsBuffer });
  try {
    const ref = await pool.call.returnsBuffer(5);
    // Safe mode claims bytes before the worker drains its hold.
    assert.deepEqual([...ref.toUint8Array()], [0, 3, 6, 9, 12]);
  } finally {
    await pool.shutdown();
  }
});

test("worker can return a borrowed BufferReference with explicit release", async () => {
  if (!supported) return;

  const pool = createPool({
    threads: 1,
    unsafe: {
      BufferReferenceReturn: "borrow",
    },
  })({ returnsBuffer });
  try {
    const ref = await pool.call.returnsBuffer(5);
    assert.deepEqual([...ref.toUint8Array()], [0, 3, 6, 9, 12]);

    ref.release();
    assert.throws(() => ref.toUint8Array(), /released/);
  } finally {
    await pool.shutdown();
  }
});

test("borrowed BufferReference return can be released without materializing", async () => {
  if (!supported) return;

  const pool = createPool({
    threads: 1,
    unsafe: {
      BufferReferenceReturn: "borrow",
    },
  })({ returnsBuffer });
  try {
    const ref = await pool.call.returnsBuffer(5);
    ref.release();
    assert.throws(() => ref.toUint8Array(), /released/);
  } finally {
    await pool.shutdown();
  }
});

test("borrowed claim: release revokes escaped views before the pin drops", () => {
  if (!supported) return;

  const producer = new BufferReference(new Uint8Array([10, 20, 30]));
  const released: bigint[] = [];
  try {
    const consumer = withBufferReferenceReturnReleaser(
      (token) => void released.push(token),
      () =>
        BufferReference.fromMetadata(producer.toMetadata()).claimOwnership(),
    );
    const view = consumer.toUint8Array();
    assert.deepEqual([...view], [10, 20, 30]);

    consumer.release();
    assert.equal(view.byteLength, 0, "escaped views are revoked by release");
    assert.equal(released.length, 1, "worker pin released exactly once");
  } finally {
    finishReference(producer);
  }
});

test("borrow track hook records the reference, then its alias on first read", () => {
  if (!supported) return;

  const producer = new BufferReference(new Uint8Array([1, 2, 3]));
  const tracked: {
    ref: BufferReference;
    token: bigint;
    buffer: ArrayBuffer | undefined;
  }[] = [];
  try {
    const consumer = withBufferReferenceReturnReleaser(
      {
        release: () => {},
        track: (ref, token, buffer) =>
          void tracked.push({
            ref,
            token,
            buffer,
          }),
      },
      () =>
        BufferReference.fromMetadata(producer.toMetadata()).claimOwnership(),
    );
    assert.equal(tracked.length, 1, "claim tracks the reference eagerly");
    assert.equal(tracked[0]!.ref, consumer);
    assert.equal(
      tracked[0]!.buffer,
      undefined,
      "no alias exists before the first read",
    );

    consumer.toUint8Array();
    assert.equal(tracked.length, 2, "first read tracks the alias buffer");
    assert.equal(tracked[1]!.token, tracked[0]!.token);
    assert.deepEqual([...new Uint8Array(tracked[1]!.buffer!)], [1, 2, 3]);
    consumer.release();
  } finally {
    finishReference(producer);
  }
});

test("revokeBorrow with copy keeps an unread reference readable", () => {
  if (!supported) return;

  const producer = new BufferReference(new Uint8Array([11, 22, 33]));
  const released: bigint[] = [];
  try {
    const consumer = withBufferReferenceReturnReleaser(
      (token) => void released.push(token),
      () =>
        BufferReference.fromMetadata(producer.toMetadata()).claimOwnership(),
    );

    // Never materialized before the revoke.
    consumer.revokeBorrow(true);

    assert.deepEqual(
      [...consumer.toUint8Array()],
      [11, 22, 33],
      "unread reference survives on bytes taken at revoke time",
    );
    assert.equal(released.length, 1);
  } finally {
    finishReference(producer);
  }
});

test("revokeBorrow without copy poisons an unread reference", () => {
  if (!supported) return;

  const producer = new BufferReference(new Uint8Array([1, 2, 3]));
  try {
    const consumer = withBufferReferenceReturnReleaser(
      () => {},
      () =>
        BufferReference.fromMetadata(producer.toMetadata()).claimOwnership(),
    );

    consumer.revokeBorrow(false);

    assert.throws(
      () => consumer.toUint8Array(),
      /released/,
      "an unread borrow must not materialize after its worker is gone",
    );
  } finally {
    finishReference(producer);
  }
});

test("revokeBorrow with copy keeps the reference readable and revokes views", () => {
  if (!supported) return;

  const producer = new BufferReference(new Uint8Array([7, 8, 9]));
  const released: bigint[] = [];
  try {
    const consumer = withBufferReferenceReturnReleaser(
      (token) => void released.push(token),
      () =>
        BufferReference.fromMetadata(producer.toMetadata()).claimOwnership(),
    );
    const view = consumer.toUint8Array();

    consumer.revokeBorrow(true);

    assert.equal(view.byteLength, 0, "old views are revoked");
    assert.deepEqual(
      [...consumer.toUint8Array()],
      [7, 8, 9],
      "the reference survives on owned bytes",
    );
    assert.equal(released.length, 1, "early release sent while worker lives");

    consumer.release();
    assert.equal(released.length, 1, "release() does not double-release");
  } finally {
    finishReference(producer);
  }
});

test("revokeBorrow without copy makes reads fail loud", () => {
  if (!supported) return;

  const producer = new BufferReference(new Uint8Array([4, 5, 6]));
  try {
    const consumer = withBufferReferenceReturnReleaser(
      () => {},
      () =>
        BufferReference.fromMetadata(producer.toMetadata()).claimOwnership(),
    );
    const view = consumer.toUint8Array();

    consumer.revokeBorrow(false);

    assert.equal(view.byteLength, 0, "old views are revoked");
    assert.throws(() => consumer.toUint8Array());
  } finally {
    finishReference(producer);
  }
});

test("pool shutdown revokes outstanding borrowed returns safely", async () => {
  if (!supported) return;

  const pool = createPool({
    threads: 1,
    unsafe: {
      BufferReferenceReturn: "borrow",
    },
  })({ returnsBuffer });

  let ref!: BufferReference;
  let view!: Uint8Array;
  try {
    ref = await pool.call.returnsBuffer(5);
    view = ref.toUint8Array();
    assert.deepEqual([...view], [0, 3, 6, 9, 12]);
  } finally {
    await pool.shutdown();
  }

  assert.equal(view.byteLength, 0, "borrowed views are revoked at shutdown");
  assert.deepEqual(
    [...ref.toUint8Array()],
    [0, 3, 6, 9, 12],
    "the reference itself survives shutdown on copied bytes",
  );
  ref.release();
});

test("default stealing tracks borrowed returns on the producing worker", async () => {
  if (!supported) return;

  const pool = createPool({
    threads: 3,
    unsafe: {
      BufferReferenceReturn: "borrow",
    },
  })({ returnsBuffer });

  let ref!: BufferReference;
  let view!: Uint8Array;
  try {
    ref = await pool.call.returnsBuffer(5);
    view = ref.toUint8Array();
    assert.deepEqual([...view], [0, 3, 6, 9, 12]);
  } finally {
    await pool.shutdown();
  }

  assert.equal(view.byteLength, 0, "the producing lane's borrow was revoked");
  assert.deepEqual(
    [...ref.toUint8Array()],
    [0, 3, 6, 9, 12],
    "the returned reference survives shutdown on copied bytes",
  );
  ref.release();
});

test("BufferReference round-trips host -> worker -> host", async () => {
  if (!supported) return;

  const pool = createPool({ threads: 1 })({ echoBufferPlusOne });
  try {
    const input = new Uint8Array([1, 2, 3, 4]);
    const out = await pool.call.echoBufferPlusOne(new BufferReference(input));

    assert.equal(input.byteLength, 0, "forward input is moved (detached)");
    assert.deepEqual(
      [...out.toUint8Array()],
      [2, 3, 4, 5],
      "host receives the worker's returned buffer",
    );
  } finally {
    await pool.shutdown();
  }
});
