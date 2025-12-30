// bench-encodeinto-subarray.mjs
//
// Run (Node):
//   npm i -D mitata
//   node --version
//   node bench-encodeinto-subarray.mjs
//
// Run (Bun):
//   bun add -d mitata
//   bun bench-encodeinto-subarray.mjs
//
// Deno note:
//   Mitata is primarily used with Node/Bun. Deno can run npm modules,
//   but if it fights you, run this bench in Node/Bun for clean numbers.

import { bench, group, run } from "mitata";

const enc = new TextEncoder();

// "Small-ish" but non-trivial (multi-byte char included)
const s = "hello-encodeInto-0123456789";

// Backing buffer
const N = 64 * 1024;
const buf = new Uint8Array(N);

const start = 123;
const len = 128;

// Reused view baseline
const fixedView = buf.subarray(start, start + len);

let sink = 0;

group("TextEncoder.encodeInto vs view creation", () => {
  bench("encodeInto (reuse view)", () => {
    const r = enc.encodeInto(s, fixedView);
    sink ^= r.written;
  });

  bench("subarray only", () => {
    // tiny varying offset to avoid over-specialization
    const off = start + (sink & 7);
    const v = buf.subarray(off, off + len);
    sink ^= v.byteOffset;
  });

  bench("subarray + encodeInto", () => {
    const off = start + (sink & 7);
    const v = buf.subarray(off, off + len);
    const r = enc.encodeInto(s, v);
    sink ^= r.written;
  });

  bench("slice + encodeInto (copy)", () => {
    const off = start + (sink & 7);
    const c = buf.slice(off, off + len); // alloc + copy
    const r = enc.encodeInto(s, c);
    sink ^= r.written;
  });
});

// Optional: a second group with bigger strings, if you want to see when encode dominates.
// Uncomment if useful.

const big = "x".repeat(4096)  + "y".repeat(4096);
group("Bigger payload", () => {
  bench("encodeInto (reuse view)", () => {
    const r = enc.encodeInto(big, fixedView);
    sink ^= r.written;
  });
  bench("subarray + encodeInto", () => {
    const off = start + (sink & 7);
    const v = buf.subarray(off, off + len);
    const r = enc.encodeInto(big, v);
    sink ^= r.written;
  });
});


await run();

if (sink === 42) console.log("✨"); // keep sink "observable"
