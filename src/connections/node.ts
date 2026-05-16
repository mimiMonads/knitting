import { getNodeBuiltinModule } from "../common/node-compat.ts";
import {
  type CreateSharedMemoryOptions,
  expectFd,
  expectPositiveSize,
  type MapSharedMemoryOptions,
  readCreateMode,
  readCreateName,
  readRequiredCreateName,
  readCreateSize,
  type SharedMemoryConnectionPrimitives,
  type SharedMemoryMapping,
} from "./types.ts";

export type NodeSharedMemoryNativeMapping = {
  sab: SharedArrayBuffer;
  fd: number;
  size: number;
  baseAddressMod64?: number;
};

export type NodeSharedMemoryAddon = {
  createSharedMemory: (
    size: number,
    name?: string,
    mode?: CreateSharedMemoryOptions["mode"],
  ) => NodeSharedMemoryNativeMapping;
  mapSharedMemory: (fd: number, size: number) => NodeSharedMemoryNativeMapping;
  unlinkSharedMemory?: (name: string) => boolean;
};

export type NodeFutexWaitResult =
  | "woken"
  | "changed"
  | "interrupted"
  | "timed-out";

export type NodeFutexAddon = {
  waitU32: (
    buffer: ArrayBuffer | SharedArrayBuffer,
    byteOffset: number,
    expected: number,
    timeoutMs?: number,
  ) => NodeFutexWaitResult;
  wakeU32: (
    buffer: ArrayBuffer | SharedArrayBuffer,
    byteOffset: number,
    count?: number,
  ) => number;
  notifyU32?: (
    buffer: ArrayBuffer | SharedArrayBuffer,
    byteOffset: number,
    count?: number,
  ) => number;
  sleep?: (milliseconds?: number) => void;
  yield?: () => void;
};

type NodeModuleBuiltin = {
  createRequire: (url: string) => (specifier: string) => unknown;
};

export const DEFAULT_NODE_SHARED_MEMORY_ADDON =
  "../../build/Release/knitting_shared_memory.node";
export const DEFAULT_NODE_FUTEX_ADDON =
  "../../build/Release/knitting_shm.node";

export const loadNodeSharedMemoryAddon = (
  specifier = DEFAULT_NODE_SHARED_MEMORY_ADDON,
): NodeSharedMemoryAddon => {
  const nodeModule = getNodeBuiltinModule<NodeModuleBuiltin>("node:module");
  if (nodeModule === undefined) {
    throw new Error("Node shared memory addon can only be loaded in Node");
  }

  const require = nodeModule.createRequire(import.meta.url);
  return require(specifier) as NodeSharedMemoryAddon;
};

export const loadNodeFutexAddon = (
  specifier = DEFAULT_NODE_FUTEX_ADDON,
): NodeFutexAddon => {
  const nodeModule = getNodeBuiltinModule<NodeModuleBuiltin>("node:module");
  if (nodeModule === undefined) {
    throw new Error("Node futex addon can only be loaded in Node");
  }

  const require = nodeModule.createRequire(import.meta.url);
  return require(specifier) as NodeFutexAddon;
};

export const fromNodeNativeMapping = (
  mapped: NodeSharedMemoryNativeMapping,
): SharedMemoryMapping<SharedArrayBuffer> => ({
  runtime: "node",
  fd: mapped.fd,
  size: mapped.size,
  byteLength: mapped.sab.byteLength,
  buffer: mapped.sab,
  kind: "shared-array-buffer",
  sab: mapped.sab,
  baseAddressMod64: mapped.baseAddressMod64,
});

export const createNodeSharedMemory = (
  options: number | CreateSharedMemoryOptions,
  addon = loadNodeSharedMemoryAddon(),
): SharedMemoryMapping<SharedArrayBuffer> => {
  const size = expectPositiveSize(readCreateSize(options));
  const mode = readCreateMode(options);
  const name = mode === "anonymous"
    ? readCreateName(options, "knitting_shared_memory")
    : readRequiredCreateName(options);
  return fromNodeNativeMapping(addon.createSharedMemory(size, name, mode));
};

export const mapNodeSharedMemory = (
  options: MapSharedMemoryOptions,
  addon = loadNodeSharedMemoryAddon(),
): SharedMemoryMapping<SharedArrayBuffer> => {
  const fd = expectFd(options.fd);
  const size = expectPositiveSize(options.size);
  return fromNodeNativeMapping(addon.mapSharedMemory(fd, size));
};

export const createNodeConnectionPrimitives = (
  addon = loadNodeSharedMemoryAddon(),
): SharedMemoryConnectionPrimitives<
  SharedMemoryMapping<SharedArrayBuffer>
> => ({
  runtime: "node",
  createSharedMemory: (options) => createNodeSharedMemory(options, addon),
  mapSharedMemory: (options) => mapNodeSharedMemory(options, addon),
  unlinkSharedMemory: (name) => unlinkNodeSharedMemory(name, addon),
});

export const unlinkNodeSharedMemory = (
  name: string,
  addon = loadNodeSharedMemoryAddon(),
): boolean => {
  if (typeof addon.unlinkSharedMemory !== "function") {
    throw new Error("Node shared memory addon cannot unlink named mappings");
  }

  return addon.unlinkSharedMemory(name);
};
