import assert from "node:assert/strict";
import {
  installTerminationGuard,
  installUnhandledRejectionSilencer,
} from "../../../src/worker/safety/process.ts";

const main = (): void => {
  const g = globalThis as typeof globalThis & { process?: NodeJS.Process };
  const previousProcess = g.process;

  try {
    (g as unknown as { process?: NodeJS.Process }).process = undefined;
    assert.doesNotThrow(() => {
      installTerminationGuard();
      installUnhandledRejectionSilencer();
    });
  } finally {
    (g as unknown as { process?: NodeJS.Process }).process = previousProcess;
  }
};

try {
  main();
  console.log("probe-ok process-guard-early-return");
} catch (error) {
  console.error(error);
  process.exitCode = 2;
}
