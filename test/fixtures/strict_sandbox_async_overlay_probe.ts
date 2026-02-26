import assert from "node:assert/strict";
import { resolvePermissionProtocol } from "../../src/permission/protocol.ts";
import {
  ensureStrictSandboxRuntime,
  loadInSandbox,
} from "../../src/worker/safety/strict-sandbox.ts";

const protocol = resolvePermissionProtocol({
  permission: {
    mode: "strict",
    strict: {
      recursiveScan: true,
      sandbox: true,
    },
  },
});
assert.ok(protocol);
const runtime = ensureStrictSandboxRuntime(protocol);
assert.ok(runtime);

const fallbackRuntime = {
  ...runtime,
  context: undefined,
  vmEnabled: false,
  overlayQueue: Promise.resolve(),
  overlayQueueDepth: 0,
};

let releaseFirst: (() => void) | undefined;
let releaseSecond: (() => void) | undefined;
const firstGate = new Promise<void>((resolve) => {
  releaseFirst = resolve;
});
const secondGate = new Promise<void>((resolve) => {
  releaseSecond = resolve;
});

const wrapped = loadInSandbox(async function asyncFallbackOverlayProbe(
  which: "first" | "second",
) {
  if (which === "first") await firstGate;
  else await secondGate;
  const g = globalThis as Record<string, unknown>;
  return typeof g.process;
}, fallbackRuntime);

const firstResultPromise = wrapped("first") as Promise<string>;
const secondResultPromise = wrapped("second") as Promise<string>;
releaseFirst?.();
releaseSecond?.();

const [firstResult, secondResult] = await Promise.all([
  firstResultPromise,
  secondResultPromise,
]);
const finalProcessType = typeof (globalThis as Record<string, unknown>).process;

console.log(
  JSON.stringify({
    firstResult,
    secondResult,
    finalProcessType,
  }),
);

process.exit(0);
