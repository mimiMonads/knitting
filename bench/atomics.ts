import { bench, group, run as mitataRun } from "mitata";
import { format, print } from "./ulti/json-parse.ts";

const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4);
const view = new Int32Array(buffer);

const idx = 0;

group("atomics", () => {
  bench("add+sub", () => {
    Atomics.add(view, idx, 1);
    Atomics.sub(view, idx, 1);
  });

  bench("store(0)", () => {
    Atomics.store(view, idx, 0);
  });

  bench("store(1)+store(0)", () => {
    Atomics.store(view, idx, 1);
    Atomics.store(view, idx, 0);
  });
});

await mitataRun({
  format,
  print,
});
