// Browser stub for `src/runtime/compiled-worker.ts`. Compiled (Porffor)
// workers need a filesystem and a native toolchain; `worker.runtime` can never
// select one here.
export const spawnCompiledWorkerContext = (): never => {
  throw new Error("compiled workers are unavailable in the browser build");
};
