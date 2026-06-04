import { createPool, isMain, task } from "./knitting.ts";
import { BufferReference } from "./unsafe.ts";

// Brighten the pixels and move the result back to the host as a BufferReference.
export const brighten = task<BufferReference, BufferReference>({
  f: (ref) => {
    const src = ref.toUint8Array();
    const out = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i++) {
      out[i] = src[i] < 245 ? src[i] + 10 : 255;
    }
    return new BufferReference(out);
  },
});

if (isMain) {
  using pool = createPool({ threads: 1 })({ brighten });

  const small = new Uint8Array([0, 100, 200, 250, 255]);
  console.log("small before  :", [...small]);
  const result = await pool.call.brighten(new BufferReference(small));
  console.log("small detached:", small.byteLength === 0, "← moved, not copied");
  console.log("result        :", [...result.toUint8Array()], "\n");

  const big = new Uint8Array(16 * 1024 * 1024).fill(1);
  const t0 = performance.now();
  const out = await pool.call.brighten(new BufferReference(big));
  const ms = (performance.now() - t0).toFixed(1);
  console.log(
    `ref path      : 16 MiB moved out and returned in ${ms} ms; ` +
      `result[0] is now ${out.toUint8Array()[0]} (was 1)`,
  );
}
