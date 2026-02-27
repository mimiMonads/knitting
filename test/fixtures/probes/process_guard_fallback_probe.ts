import assert from "node:assert/strict";
import { installTerminationGuard } from "../../../src/worker/safety/process.ts";

const originalDefineProperty = Object.defineProperty;

const main = (): void => {
  const g = globalThis as typeof globalThis & {
    Bun?: { exit?: (code?: number) => never };
    Deno?: { exit?: (code?: number) => never };
  };
  const guardedProcessMethods = new Set(["exit", "kill", "abort", "reallyExit"]);

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

  Object.defineProperty = ((target: object, key: PropertyKey, descriptor: PropertyDescriptor) => {
    const name = String(key);
    if (
      (target === process && guardedProcessMethods.has(name)) ||
      (target === g.Bun && name === "exit") ||
      (target === g.Deno && name === "exit")
    ) {
      throw new Error(`simulated defineProperty failure for ${name}`);
    }
    return originalDefineProperty(target, key, descriptor);
  }) as typeof Object.defineProperty;

  try {
    installTerminationGuard();

    const proc = process as NodeJS.Process & {
      reallyExit?: (code?: number) => never;
    };

    assert.throws(() => process.exit(1), /KNT_ERROR_PROCESS_GUARD.*process\.exit/);
    assert.throws(() => process.kill(process.pid), /KNT_ERROR_PROCESS_GUARD.*process\.kill/);
    assert.throws(() => process.abort(), /KNT_ERROR_PROCESS_GUARD.*process\.abort/);
    assert.throws(() => proc.reallyExit?.(1), /KNT_ERROR_PROCESS_GUARD.*process\.reallyExit/);
    assert.throws(() => g.Bun?.exit?.(1), /KNT_ERROR_PROCESS_GUARD.*Bun\.exit/);
    assert.throws(() => g.Deno?.exit?.(1), /KNT_ERROR_PROCESS_GUARD.*Deno\.exit/);
  } finally {
    Object.defineProperty = originalDefineProperty;
  }
};

try {
  main();
  console.log("probe-ok process-guard-fallback");
} catch (error) {
  console.error(error);
  process.exitCode = 2;
}
