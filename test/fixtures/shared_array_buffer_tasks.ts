import { task } from "../../knitting.ts";

export const sabSum = task<SharedArrayBuffer, number>({
  f: (sab) => {
    const view = new Int32Array(sab);
    let sum = 0;
    for (let i = 0; i < view.length; i++) sum += view[i];
    return sum;
  },
});

export const sabIncrementFirst = task<SharedArrayBuffer, number>({
  f: (sab) => {
    const view = new Int32Array(sab);
    view[0] += 100;
    return view[0];
  },
});

export const sabIsShared = task<SharedArrayBuffer, boolean>({
  f: (sab) => sab instanceof SharedArrayBuffer,
});

export const sabEcho = task<SharedArrayBuffer, SharedArrayBuffer>({
  f: (sab) => sab,
});

/**
 * Per-isolate identity for the cross-worker token-collision regression: producer
 * tokens restart at 1 in every worker, so two workers mint the same token for
 * different buffers.
 */
const WORKER_STAMP = 1 + Math.floor(Math.random() * 250);

const spin = (ms: number): void => {
  const end = Date.now() + ms;
  while (Date.now() < end);
};

export const sabWorkerStamp = task<void, number>({
  f: () => {
    spin(2);
    return WORKER_STAMP;
  },
});

/** Each worker returns its own long-lived SAB filled with its own stamp. */
export const sabOwnStamped = task<void, SharedArrayBuffer>({
  f: (() => {
    let mine: SharedArrayBuffer | undefined;
    return () => {
      if (mine === undefined) {
        mine = new SharedArrayBuffer(64);
        new Uint8Array(mine).fill(WORKER_STAMP);
      }
      spin(2);
      return mine;
    };
  })(),
});
