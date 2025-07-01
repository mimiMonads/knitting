# knitting

```ts
import { createThreadPool, fixedPoint, isMain } from "@vixeny/knitting";

export const fn = fixedPoint({
  f: async () => "hello",
});

export const { terminateAll, callFunction, send } = createThreadPool({})({
  fn,
});

if (isMain) {
  const arr = [
    callFunction.fn(),
  ];

  send();

  await Promise.all(arr)
    .then((results) => {
      console.log("Results:", results);
    })
    .catch((error) => {
      console.error("Error:", error);
    })
    .finally(terminateAll);
}
```
