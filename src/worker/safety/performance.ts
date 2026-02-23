type GlobalWithPerfGuard = typeof globalThis & {
  __knittingPerformanceNowGuardInstalled?: boolean;
};

export const installPerformanceNowGuard = (): void => {
  const g = globalThis as GlobalWithPerfGuard;
  if (g.__knittingPerformanceNowGuardInstalled === true) return;
  g.__knittingPerformanceNowGuardInstalled = true;

  const perf = globalThis.performance as Performance | undefined;
  if (!perf || typeof perf.now !== "function") return;

  // Non-intrusive guard: ensure a high-resolution clock exists.
  // Internal timing paths capture `performance.now` directly and do not
  // require freezing global objects.
  try {
    void perf.now();
  } catch {
  }
};
