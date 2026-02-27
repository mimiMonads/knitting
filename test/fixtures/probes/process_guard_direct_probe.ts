import assert from "node:assert/strict";
import {
  installTerminationGuard,
  installUnhandledRejectionSilencer,
} from "../../../src/worker/safety/process.ts";

const expectGuard = (fn: () => unknown, label: string): void => {
  assert.throws(
    fn,
    (error: unknown) =>
      String(error).includes("KNT_ERROR_PROCESS_GUARD") &&
      String(error).includes(label),
  );
};

const main = (): void => {
  installTerminationGuard();
  installTerminationGuard();

  const proc = process as NodeJS.Process & {
    reallyExit?: (code?: number) => never;
    __knittingTerminationGuard?: boolean;
    __knittingUnhandledRejectionSilencer?: boolean;
  };
  assert.equal(proc.__knittingTerminationGuard, true);

  expectGuard(() => process.exit(1), "process.exit");
  expectGuard(() => process.kill(process.pid), "process.kill");
  expectGuard(() => process.abort(), "process.abort");
  expectGuard(() => proc.reallyExit?.(1), "process.reallyExit");

  installUnhandledRejectionSilencer();
  installUnhandledRejectionSilencer();
  assert.equal(proc.__knittingUnhandledRejectionSilencer, true);
};

try {
  main();
  console.log("probe-ok process-guard-direct");
} catch (error) {
  console.error(error);
  process.exitCode = 2;
}
