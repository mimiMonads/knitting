import { getNodeBuiltinModule } from "../common/node-compat.ts";
import {
  type CreateSharedMemoryOptions,
  expectFd,
  expectPositiveSize,
  type MapSharedMemoryOptions,
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
  createSharedMemory: (size: number) => NodeSharedMemoryNativeMapping;
  mapSharedMemory: (fd: number, size: number) => NodeSharedMemoryNativeMapping;
};

type NodeModuleBuiltin = {
  createRequire: (url: string) => (specifier: string) => unknown;
};

export const DEFAULT_NODE_SHARED_MEMORY_ADDON =
  "../../build/Release/knitting_shared_memory.node";

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
  return fromNodeNativeMapping(addon.createSharedMemory(size));
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
});
