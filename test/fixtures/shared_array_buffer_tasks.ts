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
