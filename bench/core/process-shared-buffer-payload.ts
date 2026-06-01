import { bench, group, run as mitataRun, summary } from "mitata";
import { lock2, makeTask, type Task } from "../../src/memory/lock.ts";
import { FileDescriptor } from "../../src/connections/file-descriptor.ts";
import { ProcessSharedBuffer } from "../../src/connections/process-shared-buffer.ts";
import { format, print } from "../util/json-parse.ts";

// A ProcessSharedBuffer carries only descriptor metadata across the queue, never
// the mapped bytes. With no `name`, the codec takes the numeric fast path and
// packs the descriptor into the slot's static (header) region; with a `name` it
// falls back to JSON.stringify into the same static region. This bench measures
// the encode+decode roundtrip cost of just that metadata transfer.

const lock = lock2({});

const makeDescriptor = (name?: string) =>
  new FileDescriptor({
    version: 1,
    fd: 7,
    name,
    size: 1 << 16,
    byteLength: 1 << 16,
    runtime: "node",
    kind: "shared-array-buffer",
    baseAddressMod64: 0,
  });

// No name -> numeric (raw word) static path.
const numericPsb = ProcessSharedBuffer.fromDescriptor(makeDescriptor(), {
  byteOffset: 0,
  byteLength: 4096,
});
// Named -> JSON.stringify static external-payload path.
const jsonPsb = ProcessSharedBuffer.fromDescriptor(makeDescriptor("knitting_bench"), {
  byteOffset: 0,
  byteLength: 4096,
});

const numericTask = makeTask();
const jsonTask = makeTask();

const ackAll = () => {
  Atomics.store(lock.workerBits, 0, lock.hostBits[0]);
};

const roundtrip = (task: Task, value: ProcessSharedBuffer) => {
  task.value = value;
  ackAll();
  lock.encode(task);
  lock.decode();
  lock.resolved.clear();
};

// Correctness smoke check so the bench cannot silently measure the wrong path.
const assertRoundtrips = (value: ProcessSharedBuffer) => {
  const task = makeTask();
  task.value = value;
  ackAll();
  lock.encode(task);
  lock.decode();
  const decoded = lock.resolved.shiftNoClear() as Task | undefined;
  lock.resolved.clear();
  const out = decoded?.value;
  if (
    !(out instanceof ProcessSharedBuffer) ||
    out.fd !== value.fd ||
    out.byteLength !== value.byteLength ||
    out.byteOffset !== value.byteOffset
  ) {
    throw new Error("ProcessSharedBuffer roundtrip mismatch");
  }
};

assertRoundtrips(numericPsb);
assertRoundtrips(jsonPsb);

group("ProcessSharedBuffer payload roundtrip", () => {
  summary(() => {
    bench("numeric (raw words, no name)", () => {
      roundtrip(numericTask, numericPsb);
    });
    bench("json (stringify, named)", () => {
      roundtrip(jsonTask, jsonPsb);
    });
  });
});

await mitataRun({
  format,
  print,
});
