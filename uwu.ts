import { createPool, isMain, task } from "./knitting.ts";


export const world = task({
  f: () => {
    const { resolve } = Promise.withResolvers()
    setTimeout(resolve, 5000)

  },
});

export const { shutdown, call } = createPool({
})({
  world,
});

if (isMain) {
  await Promise.all([
    call.world(),
  ])
    .finally(shutdown);
}