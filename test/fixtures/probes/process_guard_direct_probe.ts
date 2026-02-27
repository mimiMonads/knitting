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
  const g = globalThis as typeof globalThis & {
    Bun?: { exit?: (code?: number) => never };
    Deno?: { exit?: (code?: number) => never };
  };

  g.Bun = {
    exit: (_code?: number) => {
      throw new Error("original Bun.exit");
    },
  };
  g.Deno = {
    exit: (_code?: number) => {
      throw new Error("original Deno.exit");
    },
  };

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
  expectGuard(() => g.Bun?.exit?.(1), "Bun.exit");
  expectGuard(() => g.Deno?.exit?.(1), "Deno.exit");

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
