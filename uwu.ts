import { task , isMain } from "./knitting.ts";




export const hello = task({
    abortSignal: {
      hasAborted: true,
    },
    f: (_: undefined , tbh ) => {

        tbh.hasAborted()
        let total = performance.now()
        for (let index = 0; index < 10; index++) {
            total += performance.now()
        }

        return total
    }
}).createPool({

})


if (isMain) {
  const arr = Array.from({ length: 10 }, () => hello.call());

  const first = await Promise.race(
    arr.map((p, i) =>
      p.then(
        (value) => ({ i, p, ok: true as const, value }),
        (error) => ({ i, p, ok: false as const, error }),
      ),
    ),
  );

  arr.forEach((p) => {
    if (p !== first.p) p.reject?.(new Error("Cancelled after race"));
  });

  if (!first.ok) throw first.error;
  console.log("winner:", first.value);
  console.log(await Promise.allSettled(arr));

  await hello.shutdown();
}

