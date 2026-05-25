export const installPerformanceNowGuard = () => {
    const g = globalThis;
    if (g.__knittingPerformanceNowGuardInstalled === true)
        return;
    g.__knittingPerformanceNowGuardInstalled = true;
    const perf = globalThis.performance;
    if (!perf || typeof perf.now !== "function")
        return;
    // Non-intrusive guard: ensure a high-resolution clock exists.
    // Internal timing paths capture a bound `performance.now` reference and
    // do not require freezing global objects.
    try {
        void perf.now();
    }
    catch {
    }
};
