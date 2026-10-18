// Browser stub for `src/worker/thread-cpu-clock.ts`. The real module reads
// /proc through `node:fs` and libc through `bun:ffi`, neither of which a page
// can reach. Pages have no thread CPU clock, and `maxAwaitingTasks: "auto"`
// already rejects every runtime but Node and Bun.
export const threadCpuClock = (): undefined => undefined;
