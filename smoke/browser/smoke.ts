import {
  createPool,
  isMain,
  task,
} from "../../out/browser/knitting.js";

export const echoBytes = task<Uint8Array, Uint8Array>({
  f: (value) => value,
});

export const pool = isMain
  ? createPool({
    threads: 1,
  })({
    echoBytes,
  })
  : null;

void pool;
