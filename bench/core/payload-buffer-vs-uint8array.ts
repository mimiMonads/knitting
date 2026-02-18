import { bench, group, run as mitataRun, summary } from "mitata";
import { Buffer as NodeBuffer } from "node:buffer";
import { lock2, makeTask } from "../../src/memory/lock.ts";
import { format, print } from "../ulti/json-parse.ts";

const lock = lock2({});

const STATIC_BYTES = Math.max(
  1,
  Number(process.env.PAYLOAD_STATIC_BYTES ?? "256"),
);
const DYNAMIC_BYTES = Math.max(
  STATIC_BYTES + 1,
  Number(process.env.PAYLOAD_DYNAMIC_BYTES ?? "4096"),
);

const makeBytes = (length: number) => {
  const out = new Uint8Array(length);
  for (let i = 0; i < out.length; i++) out[i] = i & 0xff;
  return out;
};

const staticU8 = makeBytes(STATIC_BYTES);
const dynamicU8 = makeBytes(DYNAMIC_BYTES);
const staticBuffer = NodeBuffer.from(staticU8);
const dynamicBuffer = NodeBuffer.from(dynamicU8);

const staticU8Task = makeTask();
const staticBufferTask = makeTask();
const dynamicU8Task = makeTask();
const dynamicBufferTask = makeTask();

staticU8Task.value = staticU8;
staticBufferTask.value = staticBuffer;
dynamicU8Task.value = dynamicU8;
dynamicBufferTask.value = dynamicBuffer;

const ackAll = () => {
  Atomics.store(lock.workerBits, 0, lock.hostBits[0]);
};

const roundtrip = (task: ReturnType<typeof makeTask>) => {
  ackAll();
  lock.encode(task);
  lock.decode();
  lock.resolved.clear();
};

group(`payload roundtrip static (${STATIC_BYTES} bytes)`, () => {
  summary(() => {
    bench("Uint8Array", () => {
      roundtrip(staticU8Task);
    });
    bench("Buffer", () => {
      roundtrip(staticBufferTask);
    });
  });
});

group(`payload roundtrip dynamic (${DYNAMIC_BYTES} bytes)`, () => {
  summary(() => {
    bench("Uint8Array", () => {
      roundtrip(dynamicU8Task);
    });
    bench("Buffer", () => {
      roundtrip(dynamicBufferTask);
    });
  });
});

await mitataRun({
  format,
  print,
});
