import { assertEquals } from "jsr:@std/assert";
import { decodePayload, encodePayload } from "../src/memory/payloadCodec.ts";
import { LockBound, makeTask, TaskIndex } from "../src/memory/lock.ts";
import { register } from "../src/memory/regionRegistry.ts";

const makeCodec = () => {
  const lockSector = new SharedArrayBuffer(
    LockBound.padding * 3 + Int32Array.BYTES_PER_ELEMENT * 2,
  );
  const payload = new SharedArrayBuffer(40000);
  const headersBuffer = new Uint32Array(16);

  return {
    encode: encodePayload({ lockSector, sab: payload, headersBuffer }),
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

  assertEquals(encode(task, 0), false);
  assertEquals(task[TaskIndex.slotBuffer], 7);
});
