import { assertEquals } from "jsr:@std/assert";
import { decodePayload, encodePayload } from "../src/memory/payloadCodec.ts";
import {
  HEADER_U32_LENGTH,
  LOCK_SECTOR_BYTE_LENGTH,
  makeTask,
  PayloadBuffer,
  type PromisePayloadHandler,
  TaskIndex,
} from "../src/memory/lock.ts";
import { register } from "../src/memory/regionRegistry.ts";
import { withResolvers } from "../src/common/with-resolvers.ts";

const align64 = (n: number) => (n + 63) & ~63;
const textEncoder = new TextEncoder();

const makeCodec = (onPromise?: PromisePayloadHandler) => {
  const lockSector = new SharedArrayBuffer(
    LOCK_SECTOR_BYTE_LENGTH,
  );
  const payload = new SharedArrayBuffer(40000);
  const headersBuffer = new Uint32Array(HEADER_U32_LENGTH);

  return {
    encode: encodePayload({ lockSector, sab: payload, headersBuffer, onPromise }),
    decode: decodePayload({ lockSector, sab: payload, headersBuffer }),
    registry: register({ lockSector }),
  };
};

Deno.test("dynamic string payload stores slotBuffer and frees slot 0", () => {
  const { encode, decode, registry } = makeCodec();
  const task = makeTask();
  task.value = "x".repeat(700);

  assertEquals(encode(task, 0), true);
  assertEquals(task[TaskIndex.slotBuffer], 0);

  decode(task, 0);

  assertEquals(task.value, "x".repeat(700));
  assertEquals(registry.workerBits[0] & 1, 1);
});

Deno.test("dynamic string payloads use distinct slotBuffer values", () => {
  const { encode, decode, registry } = makeCodec();
  const first = makeTask();
  const second = makeTask();

  first.value = "a".repeat(700);
  second.value = "b".repeat(900);

  assertEquals(encode(first, 0), true);
  assertEquals(encode(second, 1), true);

  assertEquals(first[TaskIndex.slotBuffer], 0);
  assertEquals(second[TaskIndex.slotBuffer], 1);

  decode(first, 0);
  decode(second, 1);

  assertEquals(registry.workerBits[0] & 3, 3);
});

Deno.test("dynamic string uses written bytes for next dynamic allocation", () => {
  const { encode } = makeCodec();
  const first = makeTask();
  const second = makeTask();

  first.value = "x".repeat(700);
  second.value = "y".repeat(700);

  assertEquals(encode(first, 0), true);
  assertEquals(first[TaskIndex.Start], 0);
  assertEquals(first[TaskIndex.PayloadLen], 700);

  assertEquals(encode(second, 1), true);
  assertEquals(second[TaskIndex.Start], align64(700));
});

Deno.test("dynamic object JSON uses written bytes for next dynamic allocation", () => {
  const { encode } = makeCodec();
  const first = makeTask();
  const second = makeTask();
  const firstValue = { msg: "x".repeat(700) };
  const secondValue = { msg: "y".repeat(700) };
  const firstJson = JSON.stringify(firstValue);

  first.value = firstValue;
  second.value = secondValue;

  assertEquals(encode(first, 0), true);
  assertEquals(
    first[TaskIndex.PayloadLen],
    textEncoder.encode(firstJson).byteLength,
  );

  assertEquals(encode(second, 1), true);
  assertEquals(second[TaskIndex.Start], align64(first[TaskIndex.PayloadLen]));
});

Deno.test("dynamic array JSON uses written bytes for next dynamic allocation", () => {
  const { encode } = makeCodec();
  const first = makeTask();
  const second = makeTask();
  const firstValue = ["x".repeat(700)];
  const secondValue = ["y".repeat(700)];
  const firstJson = JSON.stringify(firstValue);

  first.value = firstValue;
  second.value = secondValue;

  assertEquals(encode(first, 0), true);
  assertEquals(
    first[TaskIndex.PayloadLen],
    textEncoder.encode(firstJson).byteLength,
  );

  assertEquals(encode(second, 1), true);
  assertEquals(second[TaskIndex.Start], align64(first[TaskIndex.PayloadLen]));
});

Deno.test("dynamic symbol uses written bytes for next dynamic allocation", () => {
  const { encode } = makeCodec();
  const first = makeTask();
  const second = makeTask();
  const firstKey = "x".repeat(700);
  const secondKey = "y".repeat(700);

  first.value = Symbol.for(firstKey);
  second.value = Symbol.for(secondKey);

  assertEquals(encode(first, 0), true);
  assertEquals(first[TaskIndex.PayloadLen], firstKey.length);

  assertEquals(encode(second, 1), true);
  assertEquals(second[TaskIndex.Start], align64(first[TaskIndex.PayloadLen]));
});

Deno.test("dynamic error uses written bytes for next dynamic allocation", () => {
  const { encode } = makeCodec();
  const first = makeTask();
  const second = makeTask();
  const firstMessage = "x".repeat(700);
  const secondMessage = "y".repeat(700);
  const firstPayload = JSON.stringify({
    name: "Error",
    message: firstMessage,
    stack: "",
  });

  const firstError = new Error(firstMessage);
  firstError.stack = "";
  const secondError = new Error(secondMessage);
  secondError.stack = "";

  first.value = firstError;
  second.value = secondError;

  assertEquals(encode(first, 0), true);
  assertEquals(
    first[TaskIndex.PayloadLen],
    textEncoder.encode(firstPayload).byteLength,
  );

  assertEquals(encode(second, 1), true);
  assertEquals(second[TaskIndex.Start], align64(first[TaskIndex.PayloadLen]));
});

Deno.test("static ArrayBuffer payload round-trips with ArrayBuffer type", () => {
  const { encode, decode } = makeCodec();
  const task = makeTask();
  task.value = new Uint8Array([1, 2, 3, 4, 5]).buffer;

  assertEquals(encode(task, 0), true);
  assertEquals(task[TaskIndex.Type], PayloadBuffer.StaticArrayBuffer);

  decode(task, 0);

  assertEquals(task.value instanceof ArrayBuffer, true);
  assertEquals(Array.from(new Uint8Array(task.value as ArrayBuffer)), [1, 2, 3, 4, 5]);
});

Deno.test("dynamic ArrayBuffer payload stores slotBuffer and frees slot 0", () => {
  const { encode, decode, registry } = makeCodec();
  const task = makeTask();
  const src = new Uint8Array(700);
  for (let i = 0; i < src.length; i++) src[i] = i & 0xff;
  task.value = src.buffer;

  assertEquals(encode(task, 0), true);
  assertEquals(task[TaskIndex.Type], PayloadBuffer.ArrayBuffer);
  assertEquals(task[TaskIndex.slotBuffer], 0);

  decode(task, 0);

  assertEquals(task.value instanceof ArrayBuffer, true);
  const out = new Uint8Array(task.value as ArrayBuffer);
  assertEquals(out[0], 0);
  assertEquals(out[699], 699 & 0xff);
  assertEquals(registry.workerBits[0] & 1, 1);
});

Deno.test("non-buffer payloads do not modify slotBuffer", () => {
  const { encode } = makeCodec();
  const task = makeTask();

  task[TaskIndex.slotBuffer] = 7;
  task.value = 123;

  assertEquals(encode(task, 0), true);
  assertEquals(task[TaskIndex.slotBuffer], 7);
});

Deno.test("promise payload resolves before encoding", async () => {
  let result: Parameters<PromisePayloadHandler>[1] | undefined;
  const { encode } = makeCodec((_, payload) => {
    result = payload;
  });
  const task = makeTask();
  const { promise, resolve } = withResolvers<number>();

  task.value = promise;
  assertEquals(encode(task, 0), false);

  resolve(42);
  await promise;

  assertEquals(result?.status, "fulfilled");
  if (result?.status === "fulfilled") {
    assertEquals(result.value, 42);
  }
  assertEquals(task.value, 42);
});

Deno.test("promise payload rejects before encoding", async () => {
  let result: Parameters<PromisePayloadHandler>[1] | undefined;
  const { encode } = makeCodec((_, payload) => {
    result = payload;
  });
  const task = makeTask();
  const { promise, reject } = withResolvers<number>();
  const err = new Error("boom");

  task.value = promise;
  assertEquals(encode(task, 0), false);

  reject(err);
  await promise.catch(() => undefined);

  assertEquals(result?.status, "rejected");
  if (result?.status === "rejected") {
    assertEquals(result.reason, err);
  }
  assertEquals(task.value, err);
});
