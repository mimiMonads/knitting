/** Decode the task's 10us epoch stamp. Slow samples remain observable. */
export const taskToHostMicros = (
  packedStamp: number,
  hostEpochMs: number,
): number | undefined => {
  const workerFinishedAt = Math.floor(packedStamp / 2) / 100;
  const elapsed = (hostEpochMs - workerFinishedAt) * 1000;
  // Rounding can place the task timestamp up to 5us ahead of the host.
  return Number.isFinite(elapsed) && elapsed >= -10
    ? Math.max(0, elapsed)
    : undefined;
};
