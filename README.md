# knitting

```ts
import { createThreadPool, fixedPoint, isMain } from "@vixeny/knitting";

export const a = fixedPoint({
  args: "string",
  f: async (a) => a,
});

if (isMain) {
  const { terminateAll, fastCallFunction } = createThreadPool({
    threads: 2,
  })({
    a,
  });

  await fastCallFunction.a("hello")
    .then(console.log)
    .finally(terminateAll);
}
```
