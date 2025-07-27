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
  await fastCallFunction.fn()
    .then((results) => {
      console.log("Results:", results);
    })
    .catch((error) => {
      console.error("Error:", error);
    })
    .finally(terminateAll);
}
```

## License

This software is licensed under a modified MIT License with a **No-Derivatives
clause**.

- ✅ Commercial use is **permitted**
- ✅ Personal use and copying are **permitted**
- ❌ Forking, modifying, or redistributing the code is **not allowed**
- ❌ Republishing under a different license is **not allowed**
- ✉️ Written permission is required for any derivative or redistributed work

See the [LICENSE](./LICENSE) file for full terms.
