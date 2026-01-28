import { assert, assertEquals } from "jsr:@std/assert";
import LinkList from "../src/ipc/tools/LinkList.ts";
import { LockBound, lock2, makeTask, TaskIndex } from "../src/memory/lock.ts";
import { decodePayload } from "../src/memory/payloadCodec.ts";

const makeLock = () => {
  const toBeSent = new LinkList<ReturnType<typeof makeTask>>();
  const lock = lock2({ toSentList: toBeSent });
  return { lock, toBeSent };
};

const makeValueTask = (value: unknown) => {
  const task = makeTask();
  task.value = value;
  return task;
};

Deno.test("encode/decode roundtrip values", () => {
  const { lock } = makeLock();
  const values = [123, -45.5, true, false, 9n, Infinity, -Infinity, NaN, undefined];

  for (const value of values) {
    assert(lock.encode(makeValueTask(value)));
  }

  assert(lock.decode());
  const decoded = lock.resolved.toArray().map((task) => task.value);

  assertEquals(decoded.length, values.length);
  for (let i = 0; i < values.length; i++) {
    const expected = values[i];
    const actual = decoded[i];
    if (typeof expected === "number" && Number.isNaN(expected)) {
      assert(typeof actual === "number" && Number.isNaN(actual));
      continue;
    }
    assertEquals(actual, expected);
  }
});

Deno.test("encode/decode roundtrip string", () => {
  const { lock } = makeLock();
  const value = "hello from lock";

  assert(lock.encode(makeValueTask(value)));
  assert(lock.decode());

  const decoded = lock.resolved.toArray()
  .filter((task) =>  typeof task.value === "string") ;
  assertEquals(decoded.length, 1);
  assertEquals(decoded[0].value, value);
});

Deno.test("decode is no-op with no new slots", () => {
  const { lock } = makeLock();
  assertEquals(lock.decode(), false);
});

Deno.test("encode stops when full", () => {
  const { lock } = makeLock();

  for (let i = 0; i < LockBound.slots; i++) {
    assert(lock.encode(makeValueTask(i)));
  }

  assertEquals(lock.encode(makeValueTask(999)), false);
  assertEquals(lock.hostBits[0] >>> 0, 0xFFFFFFFF);
});

Deno.test("encodeAll leaves remaining task when full", () => {
  const { lock, toBeSent } = makeLock();
  const tasks = Array.from(
    { length: LockBound.slots + 1 },
    (_, i) => makeValueTask(i),
  );

  for (const task of tasks) lock.enlist(task);

  assertEquals(lock.encodeAll(), false);
  assertEquals(toBeSent.size, 1);
  assertEquals(toBeSent.peek(), tasks[tasks.length - 1]);
});

Deno.test("decode syncs worker bits", () => {
  const { lock } = makeLock();

  lock.encode(makeValueTask(1));
  lock.encode(makeValueTask(2));

  assert(lock.decode());
  assertEquals(lock.workerBits[0], lock.hostBits[0]);
  assertEquals(lock.decode(), false);
});

Deno.test("resolveHost decodes into queue and acks worker bits", () => {
  const lockSector = new SharedArrayBuffer(
    LockBound.padding * 3 + Int32Array.BYTES_PER_ELEMENT * 2,
  );
  const headers = new SharedArrayBuffer(
    LockBound.padding +
      (LockBound.slots * TaskIndex.TotalBuff) * LockBound.slots,
  );
  const payload = new SharedArrayBuffer(
    64 * 1024 * 1024,
    { maxByteLength: 64 * 1024 * 1024 },
  );
  const lock = lock2({
    headers,
    LockBoundSector: lockSector,
    payload,
  });
  const headersBuffer = new Uint32Array(headers);
  const decode = decodePayload({ sab: payload, headersBuffer });

  const results: unknown[] = [];
  const queue = Array.from({ length: 2 }, (_, i) => {
    const task = makeTask();
    task[TaskIndex.ID] = i;
    task.resolve = (value) => {
      results[i] = value;
    };
    task.reject = (reason) => {
      results[i] = reason;
    };
    return task;
  });

  const responses = [123, "ok"];
  for (let i = 0; i < responses.length; i++) {
    const task = makeTask();
    task[TaskIndex.ID] = i;
    task.value = responses[i];
    lock.encode(task);
  }

  const resolveHost = lock.resolveHost({ queue, });

  assert(resolveHost());
  assertEquals(results, responses);
  assertEquals(lock.workerBits[0], lock.hostBits[0]);
  assertEquals(resolveHost(), 0);
});
