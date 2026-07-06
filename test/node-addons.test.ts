import assert from "node:assert/strict";
import test from "./_runner.ts";
import {
  formatNodeNativeAddonLoadError,
  SUPPORTED_NODE_NATIVE_ADDON_ABIS,
} from "../src/connections/node-addons.ts";

test("native addon support list is limited to Node 22 and 24", () => {
  assert.deepEqual(SUPPORTED_NODE_NATIVE_ADDON_ABIS, {
    "127": "22",
    "137": "24",
  });
});

test("Node 26 native addon error directs users to the FFI backend", () => {
  const message = formatNodeNativeAddonLoadError(
    "knitting_shared_memory",
    {
      arch: "x64",
      modules: "147",
      platform: "linux",
      version: "26.1.0",
    },
    ["/package/prebuilds/linux-x64-node-147/addon.node: missing"],
  );

  assert.match(message, /Node\.js 26 uses node:ffi/);
  assert.match(message, /--experimental-ffi/);
  assert.match(message, /--allow-ffi/);
  assert.match(message, /No Node ABI 147 addon is shipped/);
});

test("unsupported Node ABIs get an actionable support message", () => {
  const message = formatNodeNativeAddonLoadError(
    "knitting_shm",
    {
      arch: "x64",
      modules: "141",
      platform: "linux",
      version: "25.9.0",
    },
    [],
  );

  assert.match(message, /no native addon is shipped/);
  assert.match(message, /ABI 141/);
  assert.match(message, /Node\.js 22 \(ABI 127\)/);
  assert.match(message, /Node\.js 24 \(ABI 137\)/);
  assert.match(message, /Plain thread workers/);
});

test("supported ABI errors distinguish unsupported architectures", () => {
  const message = formatNodeNativeAddonLoadError(
    "knitting_buffer_pointer",
    {
      arch: "arm64",
      modules: "137",
      platform: "linux",
      version: "24.1.0",
    },
    [],
  );

  assert.match(message, /supported ABI \(137\)/);
  assert.match(message, /linux-arm64/);
  assert.match(message, /bun run build:native/);
});
