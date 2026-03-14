import assert from "node:assert/strict";
import test from "node:test";
import {
  createSharedArrayBuffer,
  createWasmSharedArrayBuffer,
  growSharedArrayBuffer,
  HAS_SHARED_WASM_MEMORY,
  isGrowableSharedArrayBuffer,
  isWasmSharedArrayBuffer,
  sharedArrayBufferMaxByteLength,
} from "../src/common/runtime.ts";

test("createSharedArrayBuffer exposes growable shared buffers", () => {
  const initialBytes = 4 * 1024;
  const maxBytes = 256 * 1024;
  const sab = createSharedArrayBuffer(initialBytes, maxBytes);

  assert.equal(sab instanceof SharedArrayBuffer, true);
  assert.equal(isGrowableSharedArrayBuffer(sab), true);
  assert.equal(sharedArrayBufferMaxByteLength(sab), maxBytes);
  assert.equal(sab.byteLength >= initialBytes, true);
});

test("growSharedArrayBuffer expands wasm-backed shared buffers", () => {
  const initialBytes = 4 * 1024;
  const targetBytes = 96 * 1024;
  const maxBytes = 256 * 1024;
  const sab = createSharedArrayBuffer(initialBytes, maxBytes);

  const grown = growSharedArrayBuffer(sab, targetBytes);

  assert.equal(grown.byteLength >= targetBytes, true);
  assert.equal(isGrowableSharedArrayBuffer(grown), true);
  assert.equal(sharedArrayBufferMaxByteLength(grown), maxBytes);
});

test("createWasmSharedArrayBuffer prefers shared WebAssembly.Memory when available", () => {
  const byteLength = 256;
  const sab = createWasmSharedArrayBuffer(byteLength);

  assert.equal(sab instanceof SharedArrayBuffer, true);
  assert.equal(sab.byteLength >= byteLength, true);
  assert.equal(isWasmSharedArrayBuffer(sab), HAS_SHARED_WASM_MEMORY);
});
