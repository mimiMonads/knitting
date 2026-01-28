import { assertEquals } from "jsr:@std/assert";
import { decodePayload, encodePayload } from "../src/memory/payloadCodec.ts";
import {
  LockBound,
  makeTask,
  type PromisePayloadHandler,
  TaskIndex,
} from "../src/memory/lock.ts";
import { register } from "../src/memory/regionRegistry.ts";
import { withResolvers } from "../src/common/with-resolvers.ts";

const makeCodec = (onPromise?: PromisePayloadHandler) => {
  const lockSector = new SharedArrayBuffer(
    LockBound.padding * 3 + Int32Array.BYTES_PER_ELEMENT * 2,
  );
  const payload = new SharedArrayBuffer(40000);
  const headersBuffer = new Uint32Array(16);

  return {
    encode: encodePayload({ lockSector, sab: payload, headersBuffer, onPromise }),
    decode: decodePayload({ lockSector, sab: payload, headersBuffer }),
    registry: register({ lockSector }),
  };
};

Deno.test("string payload stores slotBuffer and frees slot 0", () => {
  const { encode, decode, registry } = makeCodec();
  const task = makeTask();
  task.value = "";

  assertEquals(encode(task, 0), true);
  assertEquals(task[TaskIndex.slotBuffer], 0);

  decode(task, 0);

  assertEquals(task.value, "");
  assertEquals(registry.workerBits[0] & 1, 1);
});

Deno.test("string payloads use distinct slotBuffer values", () => {
  const { encode, decode, registry } = makeCodec();
  const first = makeTask();
  const second = makeTask();

  first.value = "a";
  second.value = "b";

  assertEquals(encode(first, 0), true);
  assertEquals(encode(second, 1), true);

  assertEquals(first[TaskIndex.slotBuffer], 0);
  assertEquals(second[TaskIndex.slotBuffer], 1);

  decode(first, 0);
  decode(second, 1);

  assertEquals(registry.workerBits[0] & 3, 3);
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
