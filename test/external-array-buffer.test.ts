import assert from "node:assert/strict";
import test from "./_runner.ts";
import {
  detachExternalArrayBuffer,
  requireDetachedExternalArrayBuffer,
} from "../src/connections/external-array-buffer.ts";

test("external ArrayBuffer detachment invalidates existing views", () => {
  const buffer = new ArrayBuffer(64);
  const view = new Uint8Array(buffer);
  view[0] = 7;

  assert.equal(detachExternalArrayBuffer(buffer), true);
  assert.equal(buffer.byteLength, 0);
  assert.equal(view.byteLength, 0);
  assert.doesNotThrow(() => requireDetachedExternalArrayBuffer(buffer));
});
