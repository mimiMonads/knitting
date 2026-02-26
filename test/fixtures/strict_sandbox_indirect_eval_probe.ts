import assert from "node:assert/strict";
import { resolvePermissionProtocol } from "../../src/permission/protocol.ts";
import {
  ensureStrictSandboxRuntime,
  loadInSandbox,
  loadModuleInSandbox,
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

const moduleSpecifier = new URL(
  "./strict_sandbox_indirect_eval_target.ts",
  import.meta.url,
).href;
const loaded = await loadModuleInSandbox(moduleSpecifier, fallbackRuntime);
const probe = loaded.namespace.probeIndirectEval;
assert.equal(typeof probe, "function");
const wrapped = loadInSandbox(
  probe as (...args: unknown[]) => unknown,
  fallbackRuntime,
);
const result = await Promise.resolve(wrapped());

console.log(
  JSON.stringify({
    loadedInSandbox: loaded.loadedInSandbox,
    result: String(result),
  }),
);

process.exit(0);
