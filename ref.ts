import { createPool, isMain, task } from "./knitting.ts";
import { BufferReference } from "./unsafe.ts";

export const brighten = task<BufferReference, number>({
  f: (ref) => {
    const px = ref.toUint8Array();
    let sum = 0;
    for (let i = 0; i < px.length; i++) {
      px[i] = px[i] < 245 ? px[i] + 10 : 255;
      sum += px[i];
    }
    return sum;
  },
});

export const brightenCopy = task<Uint8Array, number>({
  f: (px) => {
    let sum = 0;
    for (let i = 0; i < px.length; i++) sum += px[i];
    return sum;
  },
});

if (isMain) {
  using pool = createPool({ threads: 1 })({ brighten, brightenCopy });

  const small = new Uint8Array([0, 100, 200, 250, 255]);
  console.log("small before:", [...small]);
  await pool.call.brighten(new BufferReference(small));
  console.log("small after :", [...small], "← edited by the worker, nothing copied back\n");

  const big = new Uint8Array(16 * 1024 * 1024).fill(1);

  try {
    await pool.call.brightenCopy(big);
    console.log("copy path   : sent 16 MiB (unexpected!)");
  } catch (err) {
    console.log("copy path   : rejected —", (err as Error));
  }

  const t0 = performance.now();
  const sum = await pool.call.brighten(new BufferReference(big));
  const ms = (performance.now() - t0).toFixed(1);
  console.log(`ref path    : 16 MiB processed in ${ms} ms; big[0] is now ${big[0]} (was 1)`);
  console.log("worker sum  :", sum.toLocaleString());
}
