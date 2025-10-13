# knitting

```ts
import { createThreadPool, fixedPoint, isMain } from "@vixeny/knitting";

export const hello = fixedPoint({
  f: async () => "hello",
});
export const world = fixedPoint({
  f: async () => "world",
});

export const { terminateAll, fastCallFunction } = createThreadPool({
  threads: 2,
})({
  hello,
  world,
});

if (isMain) {
  await Promise.all([
    fastCallFunction.hello(),
    fastCallFunction.world(),
  ])
    .then((results) => {
      console.log("Results:", results);
    })
    .finally(terminateAll);
}
```

```ts
import { isMain, task } from "@vixeny/knitting";

export const hello = task({
  f: async () => "hello",
}).createThreadPool({
  threads: 2,
});

if (isMain) {
  await hello.call()
    .then(console.log)
    .finally(hello.shutdown);
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
