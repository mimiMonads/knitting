// Browser stub for `src/runtime/node-doorbell.ts`. The real module reaches the
// `knitting_doorbell` addon through `createRequire`, which drags the native
// addon loader — and with it `node:fs`, `node:path`, and `node:module` — into a
// bundle that can never load a `.node` file.
//
// Both exports are already optional capabilities: the dispatcher falls back to
// `Atomics.waitAsync` and the worker to its plain publish path when they return
// nothing, which is exactly what the real module does off Node.
export const createNodeCompletionDoorbell = (): undefined => undefined;

export const createNodeCompletionNotifier = (): undefined => undefined;
