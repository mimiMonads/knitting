import { createThreadPool, fixedPoint, isMain } from "./main.ts";

import { inLine } from "./bench/functions.ts";


 const a =  new Uint8Array([3])
if (isMain) {
  const { terminateAll, callFunction , send } = createThreadPool({
    threads: 1,
    debug: {
      logMain: true,
      logThreads: true,
    },
  })({
  
    inLine
  });


     const arr = [
      callFunction.inLine(a),
      callFunction.inLine(a),

     ]

     send()

    await Promise.all(arr).then(terminateAll)



}
