import { bench, group, run as mitataRun } from "mitata";
import { createPool, isMain, task } from "../knitting.ts";
import { format, print } from "./ulti/json-parse.ts";

export const echoString = task<string, string>({
  f: (value) => value,
});

export const echoBytes = task<Uint8Array, Uint8Array>({
  f: (value) => value,
});

const MIN_SIZE = Number(process.env.CALL_GROWTH_MIN ?? "32");
const MAX_SIZE = Number(process.env.CALL_GROWTH_MAX ?? String(1024 * 1024));
const THREADS = Number(process.env.CALL_GROWTH_THREADS ?? "1");

const makeSizes = (min: number, max: number) => {
  const sizes: number[] = [];
  for (let size = min; size <= max; size *= 2) sizes.push(size);
  return sizes;
};

const ASCII_SOURCE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";

const makeAscii = (size: number) => {
  let out = "";
  while (out.length < size) out += ASCII_SOURCE;
  return out.slice(0, size);
};

const makeBytes = (size: number) => {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = i & 255;
  return out;
};

const pool = createPool({
  threads: THREADS,
  payloadInitialBytes: 64 * 1028 *1028
})({ echoString, echoBytes });

let sink = 0;

if (isMain) {
  if (!Number.isFinite(MIN_SIZE) || !Number.isFinite(MAX_SIZE)) {
    throw new Error("CALL_GROWTH_MIN/MAX must be finite numbers");
  }
  if (MIN_SIZE < 1) throw new Error("CALL_GROWTH_MIN must be >= 1");
  if (MAX_SIZE < MIN_SIZE) throw new Error("Size bounds are invalid");

  const sizes = makeSizes(MIN_SIZE, MAX_SIZE);
  const stringPayloads = new Map<number, string>();
  const uint8Payloads = new Map<number, Uint8Array>();

  for (const size of sizes) {
    stringPayloads.set(size, makeAscii(size));
    uint8Payloads.set(size, makeBytes(size));
  }

  group(`call growth string (ascii ${MIN_SIZE}..${MAX_SIZE} x2)`, () => {
    for (const size of sizes) {
      const payload = stringPayloads.get(size) as string;
      bench(`${size} B`, async () => {
        const value = await pool.call.echoString(payload);
        sink ^= value.length;
      });
    }
  });

  group(`call growth uint8array (${MIN_SIZE}..${MAX_SIZE} x2)`, () => {
    for (const size of sizes) {
      const payload = uint8Payloads.get(size) as Uint8Array;
      bench(`${size} B`, async () => {
        const value = await pool.call.echoBytes(payload);
        sink ^= value.byteLength;
      });
    }
  });

  await mitataRun({
    format,
    print,
  });

  if (sink === Number.MIN_SAFE_INTEGER) {
    console.log("unreachable", sink);
  }

  await pool.shutdown();
}
