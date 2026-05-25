import { getNodeProcess } from "./node-compat.js";
const globals = globalThis;
const nodeProcess = getNodeProcess();
export const IS_DENO = typeof globals.Deno?.version?.deno === "string";
export const IS_BUN = typeof globals.Bun?.version === "string";
export const IS_NODE = typeof nodeProcess?.versions?.node === "string";
export const RUNTIME = (IS_DENO ? "deno" : IS_BUN ? "bun" : IS_NODE ? "node" : "unknown");
export const SET_IMMEDIATE = typeof globals.setImmediate === "function" ? globals.setImmediate : undefined;
const WASM_MEMORY_PAGE_BYTES = 64 * 1024;
const wasmSharedBufferMemory = new WeakMap();
const wasmSharedBufferMaxByteLength = new WeakMap();
const hasSharedWasmMemory = (() => {
    if (typeof WebAssembly?.Memory !== "function")
        return false;
    try {
        void new WebAssembly.Memory({ initial: 0, maximum: 1, shared: true });
        return true;
    }
    catch {
        return false;
    }
})();
export const HAS_SHARED_WASM_MEMORY = hasSharedWasmMemory;
const roundupWasmPages = (byteLength) => Math.ceil(Math.max(0, byteLength) / WASM_MEMORY_PAGE_BYTES);
const createSharedWasmBuffer = (byteLength, maxByteLength) => {
    const memory = new WebAssembly.Memory({
        initial: roundupWasmPages(byteLength),
        maximum: Math.max(roundupWasmPages(byteLength), roundupWasmPages(maxByteLength)),
        shared: true,
    });
    const buffer = memory.buffer;
    wasmSharedBufferMemory.set(buffer, memory);
    wasmSharedBufferMaxByteLength.set(buffer, maxByteLength);
    return buffer;
};
export const createWasmSharedArrayBuffer = (byteLength, maxByteLength = byteLength) => {
    if (hasSharedWasmMemory) {
        return createSharedWasmBuffer(byteLength, maxByteLength);
    }
    return new SharedArrayBuffer(byteLength);
};
const HAS_NATIVE_SAB_GROW = typeof SharedArrayBuffer === "function" &&
    typeof SharedArrayBuffer.prototype.grow === "function";
export const HAS_SAB_GROW = HAS_NATIVE_SAB_GROW || hasSharedWasmMemory;
export const createSharedArrayBuffer = (byteLength, maxByteLength) => {
    if (HAS_NATIVE_SAB_GROW && typeof maxByteLength === "number") {
        return new SharedArrayBuffer(byteLength, { maxByteLength });
    }
    if (hasSharedWasmMemory && typeof maxByteLength === "number") {
        return createSharedWasmBuffer(byteLength, maxByteLength);
    }
    return new SharedArrayBuffer(byteLength);
};
export const isWasmSharedArrayBuffer = (sab) => wasmSharedBufferMemory.has(sab);
export const isGrowableSharedArrayBuffer = (sab) => {
    const value = sab;
    return (HAS_NATIVE_SAB_GROW &&
        typeof value.grow === "function" &&
        value.growable === true) ||
        wasmSharedBufferMemory.has(sab);
};
export const sharedArrayBufferMaxByteLength = (sab) => {
    const value = sab;
    if (typeof value.maxByteLength === "number") {
        return value.maxByteLength;
    }
    return wasmSharedBufferMaxByteLength.get(sab) ?? sab.byteLength;
};
export const growSharedArrayBuffer = (sab, byteLength) => {
    const native = sab;
    if (typeof native.grow === "function") {
        native.grow(byteLength);
        return sab;
    }
    const memory = wasmSharedBufferMemory.get(sab);
    if (memory == null) {
        throw new TypeError("SharedArrayBuffer is not growable");
    }
    const currentBuffer = memory.buffer;
    if (currentBuffer.byteLength >= byteLength) {
        return currentBuffer;
    }
    const targetPages = roundupWasmPages(byteLength);
    const currentPages = roundupWasmPages(currentBuffer.byteLength);
    memory.grow(targetPages - currentPages);
    const nextBuffer = memory.buffer;
    const maxByteLength = wasmSharedBufferMaxByteLength.get(sab) ?? currentBuffer.byteLength;
    wasmSharedBufferMemory.set(nextBuffer, memory);
    wasmSharedBufferMaxByteLength.set(nextBuffer, maxByteLength);
    return nextBuffer;
};
