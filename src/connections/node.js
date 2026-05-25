import { getNodeBuiltinModule } from "../common/node-compat.js";
import { loadNodeNativeAddon } from "./node-addons.js";
import { assertPosixSharedMemoryPlatform } from "./posix.js";
import { expectFd, expectPositiveSize, readCreateMode, readCreateName, readRequiredCreateName, readCreateSize, } from "./types.js";
export const DEFAULT_NODE_SHARED_MEMORY_ADDON = "../../build/Release/knitting_shared_memory.node";
export const DEFAULT_NODE_FUTEX_ADDON = "../../build/Release/knitting_shm.node";
export const loadNodeSharedMemoryAddon = (specifier) => {
    assertPosixSharedMemoryPlatform("Node native shared memory");
    const nodeModule = getNodeBuiltinModule("node:module");
    if (nodeModule === undefined) {
        throw new Error("Node shared memory addon can only be loaded in Node");
    }
    const require = nodeModule.createRequire(import.meta.url);
    return loadNodeNativeAddon(require, "knitting_shared_memory", specifier);
};
export const loadNodeFutexAddon = (specifier) => {
    assertPosixSharedMemoryPlatform("Node native futex helpers");
    const nodeModule = getNodeBuiltinModule("node:module");
    if (nodeModule === undefined) {
        throw new Error("Node futex addon can only be loaded in Node");
    }
    const require = nodeModule.createRequire(import.meta.url);
    return loadNodeNativeAddon(require, "knitting_shm", specifier);
};
export const fromNodeNativeMapping = (mapped) => ({
    runtime: "node",
    fd: mapped.fd,
    size: mapped.size,
    byteLength: mapped.sab.byteLength,
    buffer: mapped.sab,
    kind: "shared-array-buffer",
    sab: mapped.sab,
    baseAddressMod64: mapped.baseAddressMod64,
});
export const createNodeSharedMemory = (options, addon = loadNodeSharedMemoryAddon()) => {
    const size = expectPositiveSize(readCreateSize(options));
    const mode = readCreateMode(options);
    const name = mode === "anonymous"
        ? readCreateName(options, "knitting_shared_memory")
        : readRequiredCreateName(options);
    return fromNodeNativeMapping(addon.createSharedMemory(size, name, mode));
};
export const mapNodeSharedMemory = (options, addon = loadNodeSharedMemoryAddon()) => {
    const fd = expectFd(options.fd);
    const size = expectPositiveSize(options.size);
    return fromNodeNativeMapping(addon.mapSharedMemory(fd, size));
};
export const createNodeConnectionPrimitives = (addon = loadNodeSharedMemoryAddon()) => ({
    runtime: "node",
    createSharedMemory: (options) => createNodeSharedMemory(options, addon),
    mapSharedMemory: (options) => mapNodeSharedMemory(options, addon),
    unlinkSharedMemory: (name) => unlinkNodeSharedMemory(name, addon),
});
export const unlinkNodeSharedMemory = (name, addon = loadNodeSharedMemoryAddon()) => {
    if (typeof addon.unlinkSharedMemory !== "function") {
        throw new Error("Node shared memory addon cannot unlink named mappings");
    }
    return addon.unlinkSharedMemory(name);
};
