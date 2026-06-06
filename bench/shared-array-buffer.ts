import { bench, group, run as mitataRun } from "mitata";
import { createPool, isMain, task } from "../knitting.ts";
import { BufferReference } from "../unsafe.ts";
import { format, print } from "./util/json-parse.ts";

const SIZES = [
  1024,
  512 * 1024,
  4 * 1024 * 1024,
  8 * 1024 * 1024,
] as const;
const WARMUP = 20;

const PAYLOAD_INITIAL_BYTES = 16 * 1024 * 1024;
const PAYLOAD_MAX_BYTE_LENGTH = 64 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

const fmtBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MiB` : `${bytes / 1024} KiB`;

export const touchBytes = task<Uint8Array, number>({
  f: (value) => value.byteLength,
});

export const touchSAB = task<SharedArrayBuffer, number>({
  f: (value) => value.byteLength,
});

export const touchRef = task<BufferReference, number>({
  f: (value) => value.byteLength,
});

let sink = 0;

if (isMain) {
  const pool = createPool({
    threads: 1,
    payload: {
      payloadInitialBytes: PAYLOAD_INITIAL_BYTES,
      payloadMaxByteLength: PAYLOAD_MAX_BYTE_LENGTH,
      maxPayloadBytes: MAX_PAYLOAD_BYTES,
    },
  })({ touchBytes, touchSAB, touchRef });

  try {
    for (const size of SIZES) {
      const bytes = new Uint8Array(size);
      const sab = new SharedArrayBuffer(size);

      const runCopy = async () => {
        sink ^= await pool.call.touchBytes(bytes);
      };

      const runSAB = async () => {
        sink ^= await pool.call.touchSAB(sab);
      };

      const runRef = async () => {
        sink ^= await pool.call.touchRef(
          new BufferReference(new ArrayBuffer(size)),
        );
      };

      // BufferReference moves its source, so only copy/SAB can reuse payloads.
      for (let i = 0; i < WARMUP; i++) {
        await runCopy();
        await runSAB();
        await runRef();
      }

      group(`copy vs SAB vs BufferReference (${fmtBytes(size)})`, () => {
        bench("Uint8Array copy", runCopy);
        bench("SAB", runSAB);
        bench("BufferReference", runRef);
      });
    }

    await mitataRun({ format, print });
  } finally {
    await pool.shutdown();
  }

  if (sink === Number.MIN_SAFE_INTEGER) {
    console.log("unreachable", sink);
  }
}
