import { createPool, task, isMain , importTask} from "./knitting.ts";


export const slowUpper = task({
  abortSignal: { hasAborted: true },
  f: async (value: string, signal) => {
    if (signal.hasAborted()) return "aborted";
    await new Promise((r) => setTimeout(r, 200));
    return value.toUpperCase();
  },
});

export const pool = createPool({})({ slowUpper });

if (isMain) {
  const pending = pool.call.slowUpper("hello");
  pending.reject("it is rejected")
  // aborted
  await pending
  .then(console.log)
  .catch((reason) => console.log(reason))
  .finally(pool.shutdown);
}