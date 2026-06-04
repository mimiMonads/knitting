import { getNodeBuiltinModule } from "../common/node-compat.ts";
import { loadNodeNativeAddon } from "./node-addons.ts";

export type NodeBufferPointerAddon = {
  getPointer: (
    buffer: ArrayBufferView | ArrayBuffer | SharedArrayBuffer,
  ) => bigint;
  retainPointer: (
    buffer: ArrayBufferView | ArrayBuffer | SharedArrayBuffer,
  ) => {
    pointer: bigint;
    byteLength: number;
    token: bigint;
  };
  releasePointer: (token: bigint) => boolean;
  wrapPointer: (pointer: bigint, byteLength: number) => ArrayBuffer;
  detachArrayBuffer: (buffer: ArrayBuffer) => boolean;
  // Owning, cross-isolate move primitives (newer prebuilds only — feature-detected).
  retainBackingStore?: (
    buffer: ArrayBufferView | ArrayBuffer,
  ) => {
    pointer: bigint;
    byteOffset: number;
    byteLength: number;
    token: bigint;
  };
  adoptBackingStore?: (token: bigint) => ArrayBuffer;
  releaseBackingStore?: (token: bigint) => boolean;
};

type NodeModuleBuiltin = {
  createRequire: (url: string) => (specifier: string) => unknown;
};

let cached: NodeBufferPointerAddon | undefined;

export const loadNodeBufferPointerAddon = (
  specifier?: string,
): NodeBufferPointerAddon => {
  if (specifier === undefined && cached !== undefined) return cached;

  const nodeModule = getNodeBuiltinModule<NodeModuleBuiltin>("node:module");
  if (nodeModule === undefined) {
    throw new Error("Node buffer-pointer addon can only be loaded in Node");
  }

  const require = nodeModule.createRequire(import.meta.url);
  const addon = loadNodeNativeAddon<NodeBufferPointerAddon>(
    require,
    "knitting_buffer_pointer",
    specifier,
  );

  if (specifier === undefined) cached = addon;
  return addon;
};
