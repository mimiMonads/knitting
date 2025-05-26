import { createThreadPool, isMain } from "./main.ts";

import { aaa } from "./bench/functions.ts";

const a = new Uint8Array([3]);
if (isMain) {
  const { terminateAll, callFunction, send } = createThreadPool({
    threads: 5,
    debug: {
      logMain: true,
      logThreads: true,
    },
  })({
    aaa,
  });

  const arr = [
    callFunction.aaa(),
  ];

  send();

  await Promise.all(arr).then(terminateAll);
}
