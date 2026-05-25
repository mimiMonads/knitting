import { DARWIN_O_CREAT, DARWIN_O_EXCL, DARWIN_SHM_MODE, setCloseOnExec, detectPosixPlatform, encodeCString, getPosixLibcPath, makeDarwinSharedMemoryName, MAP_SHARED, O_RDWR, PROT_READ, PROT_WRITE, } from "./posix.js";
import { expectFd, expectPositiveSize, readCreateName, readCreateSize, } from "./types.js";
const getDeno = () => {
    const deno = globalThis.Deno;
    if (deno === undefined) {
        throw new Error("Deno shared memory primitives can only run in Deno");
    }
    return deno;
};
export const openDenoLibc = () => getDeno().dlopen(getPosixLibcPath(), {
    ...getDenoCreateSymbols(),
    ftruncate: {
        parameters: ["i32", "i64"],
        result: "i32",
    },
    dup: {
        parameters: ["i32"],
        result: "i32",
    },
    fcntl: {
        parameters: ["i32", "i32", "i32"],
        result: "i32",
    },
    mmap: {
        parameters: ["pointer", "usize", "i32", "i32", "i32", "i64"],
        result: "pointer",
    },
    munmap: {
        parameters: ["pointer", "usize"],
        result: "i32",
    },
    close: {
        parameters: ["i32"],
        result: "i32",
    },
});
const getDenoCreateSymbols = (platform = detectPosixPlatform()) => platform === "darwin"
    ? {
        shm_open: {
            parameters: ["buffer", "i32", "u32"],
            result: "i32",
        },
        shm_unlink: {
            parameters: ["buffer"],
            result: "i32",
        },
    }
    : {
        memfd_create: {
            parameters: ["buffer", "u32"],
            result: "i32",
        },
    };
const checkResult = (result, message) => {
    if (result < 0)
        throw new Error(message);
    return result;
};
const isDenoMmapFailed = (pointer) => {
    if (pointer === null)
        return true;
    const value = getDeno().UnsafePointer?.value(pointer);
    return value === -1n || value === BigInt.asUintN(64, -1n);
};
const createDenoSharedMemoryFd = (name, platform, libc) => {
    if (platform === "darwin") {
        const shmOpen = libc.symbols.shm_open;
        const shmUnlink = libc.symbols.shm_unlink;
        if (shmOpen === undefined || shmUnlink === undefined) {
            throw new Error("shm_open symbols are not available");
        }
        const shmName = encodeCString(makeDarwinSharedMemoryName(name, "deno"));
        const fd = checkResult(shmOpen(shmName, O_RDWR | DARWIN_O_CREAT | DARWIN_O_EXCL, DARWIN_SHM_MODE), "shm_open failed");
        shmUnlink(shmName);
        try {
            return setCloseOnExec(libc, fd);
        }
        catch (error) {
            libc.symbols.close(fd);
            throw error;
        }
    }
    const memfdCreate = libc.symbols.memfd_create;
    if (memfdCreate === undefined) {
        throw new Error("memfd_create symbol is not available");
    }
    const fd = checkResult(memfdCreate(encodeCString(name), 0), "memfd_create failed");
    try {
        return setCloseOnExec(libc, fd);
    }
    catch (error) {
        libc.symbols.close(fd);
        throw error;
    }
};
export const mapDenoSharedMemory = (options, libc = openDenoLibc()) => {
    const sourceFd = expectFd(options.fd);
    const size = expectPositiveSize(options.size);
    let fd = sourceFd;
    if (options.duplicateFd !== false) {
        fd = checkResult(libc.symbols.dup(sourceFd), "dup(fd) failed");
        try {
            setCloseOnExec(libc, fd);
        }
        catch (error) {
            libc.symbols.close(fd);
            throw error;
        }
    }
    const pointer = libc.symbols.mmap(null, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0n);
    if (isDenoMmapFailed(pointer)) {
        if (options.duplicateFd !== false)
            libc.symbols.close(fd);
        throw new Error("mmap failed");
    }
    const arrayBuffer = new (getDeno().UnsafePointerView)(pointer)
        .getArrayBuffer(size);
    return {
        runtime: "deno",
        fd,
        size,
        byteLength: arrayBuffer.byteLength,
        buffer: arrayBuffer,
        kind: "external-array-buffer",
        arrayBuffer,
        unsafePointer: pointer,
        close: () => {
            libc.symbols.munmap(pointer, size);
            libc.symbols.close(fd);
        },
    };
};
export const createDenoSharedMemory = (options, libc = openDenoLibc()) => {
    const size = expectPositiveSize(readCreateSize(options));
    const name = readCreateName(options, "knitting_shared_memory");
    const fd = createDenoSharedMemoryFd(name, detectPosixPlatform(), libc);
    try {
        checkResult(libc.symbols.ftruncate(fd, BigInt(size)), "ftruncate failed");
        return mapDenoSharedMemory({ fd, size, duplicateFd: false }, libc);
    }
    catch (error) {
        libc.symbols.close(fd);
        throw error;
    }
};
export const createDenoConnectionPrimitives = (libc = openDenoLibc()) => ({
    runtime: "deno",
    createSharedMemory: (options) => createDenoSharedMemory(options, libc),
    mapSharedMemory: (options) => mapDenoSharedMemory(options, libc),
});
