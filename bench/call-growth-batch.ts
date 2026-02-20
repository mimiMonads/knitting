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
const BATCH_SIZE = Number(process.env.CALL_GROWTH_BATCH_SIZE ?? "64");

const makeSizes = (min: number, max: number) => {
  const sizes: number[] = [];
  for (let size = min; size <= max; size *= 4) sizes.push(size);
  if (sizes[sizes.length - 1] !== max) sizes.push(max);
  return sizes;
};

const ASCII_SOURCE =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";

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
  payloadInitialBytes: 64 * 1028 * 1028,
})({ echoString, echoBytes });

let sink = 0;

if (isMain) {
  if (!Number.isFinite(MIN_SIZE) || !Number.isFinite(MAX_SIZE)) {
    throw new Error("CALL_GROWTH_MIN/MAX must be finite numbers");
  }
  if (!Number.isFinite(BATCH_SIZE)) {
    throw new Error("CALL_GROWTH_BATCH_SIZE must be finite");
  }
  if (MIN_SIZE < 1) throw new Error("CALL_GROWTH_MIN must be >= 1");
  if (MAX_SIZE < MIN_SIZE) throw new Error("Size bounds are invalid");
  if (BATCH_SIZE < 1) throw new Error("CALL_GROWTH_BATCH_SIZE must be >= 1");

  const sizes = makeSizes(MIN_SIZE, MAX_SIZE);
  const stringPayloads = new Map<number, string>();
  const uint8Payloads = new Map<number, Uint8Array>();

  for (const size of sizes) {
    stringPayloads.set(size, makeAscii(size));
    uint8Payloads.set(size, makeBytes(size));
  }

  group(
    `call growth batch string (ascii ${MIN_SIZE}..${MAX_SIZE} x4, batch=${BATCH_SIZE})`,
    () => {
      for (const size of sizes) {
        const payload = stringPayloads.get(size) as string;
        bench(`${size} B`, async () => {
          const jobs = Array.from(
            { length: BATCH_SIZE },
            () => pool.call.echoString(payload),
          );
          const values = await Promise.all(jobs);
          for (const value of values) sink ^= value.length;
        });
      }
    },
  );

  group(
    `call growth batch uint8array (${MIN_SIZE}..${MAX_SIZE} x4, batch=${BATCH_SIZE})`,
    () => {
      for (const size of sizes) {
        const payload = uint8Payloads.get(size) as Uint8Array;
        bench(`${size} B`, async () => {
          const jobs = Array.from(
            { length: BATCH_SIZE },
            () => pool.call.echoBytes(payload),
          );
          const values = await Promise.all(jobs);
          for (const value of values) sink ^= value.byteLength;
        });
      }
    },
  );

  await mitataRun({
    format,
    print,
  });

  if (sink === Number.MIN_SAFE_INTEGER) {
    console.log("unreachable", sink);
  }

  await pool.shutdown();
}
