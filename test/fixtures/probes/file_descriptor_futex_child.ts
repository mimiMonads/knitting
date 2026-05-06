import { createRequire } from "node:module";
import { FileDescriptor } from "../../../src/connections/index.ts";
import { createNodeConnectionPrimitives } from "../../../src/connections/node.ts";

const require = createRequire(import.meta.url);
const futex = require("../../../build/Release/knitting_shm.node") as {
  waitU32: (
    buffer: ArrayBuffer | SharedArrayBuffer,
    byteOffset: number,
    expected: number,
    timeoutMs?: number,
  ) => "woken" | "changed" | "interrupted" | "timed-out";
  wakeU32: (
    buffer: ArrayBuffer | SharedArrayBuffer,
    byteOffset: number,
    count?: number,
  ) => number;
};

const descriptorJson = process.argv[2];
if (descriptorJson === undefined) {
  console.error("missing descriptor metadata");
  process.exit(2);
}

const descriptor = FileDescriptor.parse(descriptorJson);
const sab = descriptor.getSAB(createNodeConnectionPrimitives());
const cells = new Int32Array(sab);

Atomics.store(cells, 0, 1);
console.log("ready");

const waitResult = futex.waitU32(sab, 4, 0, 5000);
Atomics.store(cells, 2, 42);
const parentWakeCount = futex.wakeU32(sab, 8, 1);

console.log(JSON.stringify({
  waitResult,
  parentWakeCount,
  value: Atomics.load(cells, 2),
}));

process.exit(waitResult === "woken" ? 0 : 3);
