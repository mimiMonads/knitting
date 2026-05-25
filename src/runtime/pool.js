// main.ts
import { fileURLToPath as fileURLToPathCompat } from "node:url";
import { createHostTxQueue } from "./tx-queue.js";
import { createSharedMemoryTransport, TRANSPORT_SIGNAL_BYTES, } from "../ipc/transport/shared-memory.js";
import { ChannelHandler, hostDispatcherLoop } from "./dispatcher.js";
import { HEADER_SLOT_STRIDE_U32, lock2, LOCK_SECTOR_BYTE_LENGTH, LockBound, } from "../memory/lock.js";
import "../worker/loop.js";
import { createSharedArrayBuffer, createWasmSharedArrayBuffer, RUNTIME, } from "../common/runtime.js";
import { HAS_NODE_WORKER_THREADS, RUNTIME_PROCESS_WORKER_BOOT_ENV, RUNTIME_PROCESS_WORKER_BOOT_VERSION, RUNTIME_PROCESS_WORKER_ENV, RUNTIME_WORKER, } from "../common/worker-runtime.js";
import { toSharedBufferRegion, } from "../common/shared-buffer-region.js";
import { probeLockBufferTextCompat } from "../common/shared-buffer-text.js";
import { signalAbortFactory } from "../shared/abortSignal.js";
import { createByteCarpet, createLockControlCarpet, getHeaderBlockByteLength, makeSharedBufferRegion, } from "../memory/byte-carpet.js";
import { resolvePayloadBufferOptions, } from "../memory/payload-config.js";
import { getNodeBuiltinModule, getNodeProcess, } from "../common/node-compat.js";
import { createBunConnectionPrimitives } from "../connections/bun.js";
import { createDenoConnectionPrimitives } from "../connections/deno.js";
import { FileDescriptor, ProcessSharedBuffer, } from "../connections/index.js";
import { createNodeConnectionPrimitives, loadNodeFutexAddon, } from "../connections/node.js";
import { loadNodeNativeAddon } from "../connections/node-addons.js";
import { assertPosixSharedMemoryPlatform, detectPosixPlatform, } from "../connections/posix.js";
const WORKER_FATAL_MESSAGE_KEY = "__knittingWorkerFatal";
const execFlagKey = (flag) => flag.split("=", 1)[0];
const NODE_PERMISSION_EXEC_FLAGS = new Set([
    "--permission",
    "--experimental-permission",
    "--allow-fs-read",
    "--allow-fs-write",
    "--allow-worker",
    "--allow-child-process",
    "--allow-addons",
    "--allow-wasi",
]);
const NODE_WORKER_SAFE_EXEC_FLAGS = new Set([
    "--experimental-transform-types",
    "--expose-gc",
    "--no-warnings",
    ...NODE_PERMISSION_EXEC_FLAGS,
]);
const isWorkerFatalMessage = (value) => !!value &&
    typeof value === "object" &&
    typeof value[WORKER_FATAL_MESSAGE_KEY] === "string";
const isNodeWorkerSafeExecFlag = (flag) => NODE_WORKER_SAFE_EXEC_FLAGS.has(execFlagKey(flag));
const isNodePermissionExecFlag = (flag) => NODE_PERMISSION_EXEC_FLAGS.has(execFlagKey(flag));
const toWorkerSafeExecArgv = (flags) => {
    if (!flags || flags.length === 0)
        return undefined;
    const filtered = flags.filter(isNodeWorkerSafeExecFlag);
    if (filtered.length === 0)
        return undefined;
    const seen = new Set();
    const deduped = [];
    for (const flag of filtered) {
        if (seen.has(flag))
            continue;
        seen.add(flag);
        deduped.push(flag);
    }
    return deduped;
};
const toWorkerCompatExecArgv = (flags) => {
    const safe = toWorkerSafeExecArgv(flags);
    if (!safe || safe.length === 0)
        return undefined;
    const compat = safe.filter((flag) => !isNodePermissionExecFlag(flag));
    return compat.length > 0 ? compat : undefined;
};
// Keep idle workers self-healing if an Atomics.notify wake is missed.
const DEFAULT_WORKER_PARK_MS = 1;
const withDefaultWorkerTimers = (options) => {
    const parkMs = options?.timers?.parkMs ?? DEFAULT_WORKER_PARK_MS;
    if (options === undefined)
        return { timers: { parkMs } };
    return {
        ...options,
        timers: {
            ...options.timers,
            parkMs,
        },
    };
};
const toProcessSharedMemorySize = (byteLength) => {
    if (!Number.isFinite(byteLength) || byteLength <= 0) {
        throw new RangeError("process shared memory byteLength must be positive");
    }
    const size = Math.trunc(byteLength);
    return size + ((64 - (size % 64)) % 64);
};
const createProcessSharedMemoryAllocator = (debug) => {
    if (RUNTIME !== "node")
        return undefined;
    try {
        assertPosixSharedMemoryPlatform("Process-shared memory allocator");
    }
    catch {
        return undefined;
    }
    let addon;
    try {
        const nodeModule = getNodeBuiltinModule("node:module");
        if (nodeModule === undefined)
            return undefined;
        const require = nodeModule.createRequire(import.meta.url);
        addon = loadNodeNativeAddon(require, "knitting_shared_memory");
    }
    catch (error) {
        if (debug?.extras === true) {
            console.warn("Process-shared memory allocator unavailable; falling back to SharedArrayBuffer.", error);
        }
        return undefined;
    }
    const backings = [];
    return {
        backings,
        createBuffer: (byteLength) => {
            const mapping = addon.createSharedMemory(toProcessSharedMemorySize(byteLength));
            backings.push({
                ...mapping,
                runtime: "node",
                buffer: mapping.sab,
                kind: "shared-array-buffer",
                byteLength: mapping.sab.byteLength,
            });
            return mapping.sab;
        },
    };
};
const PROCESS_WORKER_CHILD_FD = 0;
const DEFAULT_BUN_BINARY = "bun";
const DEFAULT_DENO_BINARY = "deno";
const DEFAULT_NODE_BINARY = "node";
const DENO_PROCESS_WORKER_BOOT_ENV_ALLOW = [
    RUNTIME_PROCESS_WORKER_ENV,
    RUNTIME_PROCESS_WORKER_BOOT_ENV,
].join(",");
const DENO_PROCESS_WORKER_INTERNAL_FLAGS = [
    `--allow-env=${DENO_PROCESS_WORKER_BOOT_ENV_ALLOW}`,
    "--allow-ffi",
];
const NODE_PROCESS_WORKER_EXEC_ARGV = [
    "--no-warnings",
    "--experimental-transform-types",
];
const withFixedPayloadConfig = (config) => ({
    ...config,
    mode: "fixed",
    payloadInitialBytes: config.payloadMaxByteLength,
});
const getProcessWorkerSharedMemoryPrimitives = () => {
    assertPosixSharedMemoryPlatform("Process worker runtime");
    switch (RUNTIME) {
        case "bun":
            return createBunConnectionPrimitives();
        case "deno":
            return createDenoConnectionPrimitives();
        case "node":
            return createNodeConnectionPrimitives();
        default:
            throw new Error("process worker runtime needs Node, Deno, or Bun shared memory primitives");
    }
};
const createProcessWorkerMemoryLayout = ({ signalBytes, abortBytes, payloadBytes, thread, }) => {
    const carpet = createByteCarpet();
    const signalsSlice = carpet.take("signals", signalBytes);
    const requestLockSlice = carpet.take("requestLockSector", LOCK_SECTOR_BYTE_LENGTH);
    const returnLockSlice = carpet.take("returnLockSector", LOCK_SECTOR_BYTE_LENGTH);
    const requestHeadersSlice = carpet.take("requestHeaders", getHeaderBlockByteLength({
        slotCount: LockBound.slots,
        slotStrideU32: HEADER_SLOT_STRIDE_U32,
        alignTo: 64,
    }));
    const returnHeadersSlice = carpet.take("returnHeaders", getHeaderBlockByteLength({
        slotCount: LockBound.slots,
        slotStrideU32: HEADER_SLOT_STRIDE_U32,
        alignTo: 64,
    }));
    const abortSignalsSlice = carpet.take("abortSignals", abortBytes);
    const requestPayloadSlice = carpet.take("requestPayload", payloadBytes);
    const returnPayloadSlice = carpet.take("returnPayload", payloadBytes);
    const primitives = getProcessWorkerSharedMemoryPrimitives();
    const mapping = primitives.createSharedMemory({
        size: carpet.byteLength(),
        name: `knitting_process_worker_${thread}`,
    });
    const buffer = mapping.buffer;
    const bind = (slice) => makeSharedBufferRegion(buffer, slice.byteOffset, slice.byteLength);
    const controlLayout = {
        controlSAB: buffer,
        signals: bind(signalsSlice),
        abortSignals: bind(abortSignalsSlice),
        lock: {
            headers: bind(requestHeadersSlice),
            headerSlotStrideU32: HEADER_SLOT_STRIDE_U32,
            lockSector: bind(requestLockSlice),
            payloadSector: bind(requestLockSlice),
        },
        returnLock: {
            headers: bind(returnHeadersSlice),
            headerSlotStrideU32: HEADER_SLOT_STRIDE_U32,
            lockSector: bind(returnLockSlice),
            payloadSector: bind(returnLockSlice),
        },
        slices: carpet.slices,
    };
    return {
        mapping,
        descriptor: FileDescriptor.fromMapping(mapping),
        controlLayout,
        lockPayload: bind(requestPayloadSlice),
        returnPayload: bind(returnPayloadSlice),
    };
};
const toChildProcessSharedBufferMetadata = (source, descriptor) => {
    const region = toSharedBufferRegion(source);
    return ProcessSharedBuffer.fromDescriptor(new FileDescriptor({
        ...descriptor.toMetadata(),
        fd: PROCESS_WORKER_CHILD_FD,
    }), {
        byteOffset: region.byteOffset,
        byteLength: region.byteLength,
    }).toMetadata();
};
const toProcessWorkerWireLockBuffers = (lock, descriptor) => ({
    ...lock,
    headers: toChildProcessSharedBufferMetadata(lock.headers, descriptor),
    lockSector: toChildProcessSharedBufferMetadata(lock.lockSector, descriptor),
    payload: toChildProcessSharedBufferMetadata(lock.payload, descriptor),
    payloadSector: toChildProcessSharedBufferMetadata(lock.payloadSector, descriptor),
});
const toProcessWorkerBootPayload = (workerData, memory) => ({
    version: RUNTIME_PROCESS_WORKER_BOOT_VERSION,
    workerData: {
        ...workerData,
        sab: toChildProcessSharedBufferMetadata(workerData.sab, memory.descriptor),
        abortSignalSAB: workerData.abortSignalSAB === undefined
            ? undefined
            : toChildProcessSharedBufferMetadata(workerData.abortSignalSAB, memory.descriptor),
        lock: toProcessWorkerWireLockBuffers(workerData.lock, memory.descriptor),
        returnLock: toProcessWorkerWireLockBuffers(workerData.returnLock, memory.descriptor),
    },
});
const toProcessWorkerPath = (specifier) => {
    const value = specifier instanceof URL ? specifier.href : specifier;
    if (value.startsWith("file:"))
        return fileURLToPathCompat(value);
    return value;
};
const readProcessWorkerRuntime = (options) => {
    const runtime = options?.processRuntime ?? "bun";
    if (runtime === "bun" || runtime === "deno" || runtime === "node") {
        return runtime;
    }
    throw new TypeError(`Unsupported process worker runtime: ${String(runtime)}`);
};
const readProcessWorkerCommandPrefix = (options) => {
    const prefix = options?.processCommandPrefix;
    if (prefix === undefined)
        return undefined;
    if (!Array.isArray(prefix)) {
        throw new TypeError("processCommandPrefix must be an argv array");
    }
    if (prefix.length === 0)
        return undefined;
    const out = [];
    for (const [index, value] of prefix.entries()) {
        if (typeof value !== "string" || value.length === 0) {
            throw new TypeError(`processCommandPrefix[${index}] must be a non-empty string`);
        }
        out.push(value);
    }
    return out;
};
const currentProcessEnv = () => ({
    ...getNodeProcess()?.env,
});
const processWorkerEnv = (extra) => ({
    ...currentProcessEnv(),
    [RUNTIME_PROCESS_WORKER_ENV]: "1",
    ...extra,
});
const processWorkerBootEnv = (bootPayload) => processWorkerEnv({
    [RUNTIME_PROCESS_WORKER_BOOT_ENV]: JSON.stringify(bootPayload),
});
const stringProcessEnv = (input) => {
    const out = {};
    for (const [key, value] of Object.entries(input)) {
        if (value !== undefined)
            out[key] = value;
    }
    return out;
};
const processWorkerBunBinary = (bun) => getNodeProcess()?.env?.BUN_BINARY ??
    bun?.argv?.[0] ??
    DEFAULT_BUN_BINARY;
const processWorkerDenoBinary = (deno) => getNodeProcess()?.env?.DENO_BINARY ??
    deno?.execPath?.() ??
    DEFAULT_DENO_BINARY;
const processWorkerDenoFlags = (permission) => {
    if (permission?.enabled !== true || permission.unsafe === true) {
        return ["-A"];
    }
    return [
        ...DENO_PROCESS_WORKER_INTERNAL_FLAGS,
        ...permission.deno.flags,
    ];
};
const processWorkerNodeBinary = () => {
    const nodeProcess = getNodeProcess();
    return nodeProcess?.env?.NODE_BINARY ??
        (RUNTIME === "node" ? nodeProcess?.execPath : undefined) ??
        DEFAULT_NODE_BINARY;
};
const processWorkerNodeExecArgv = () => {
    const out = [];
    const seen = new Set();
    const add = (flag) => {
        if (seen.has(flag))
            return;
        seen.add(flag);
        out.push(flag);
    };
    for (const flag of toWorkerCompatExecArgv(getNodeProcess()?.execArgv) ?? []) {
        add(flag);
    }
    for (const flag of NODE_PROCESS_WORKER_EXEC_ARGV)
        add(flag);
    return out;
};
const processWorkerCommand = ({ processRuntime, workerUrl, bun, deno, commandPrefix, permission, }) => {
    const workerPath = toProcessWorkerPath(workerUrl);
    let command;
    if (processRuntime === "deno") {
        command = [
            processWorkerDenoBinary(deno),
            "run",
            ...processWorkerDenoFlags(permission),
            workerPath,
        ];
    }
    else if (processRuntime === "node") {
        command = [
            processWorkerNodeBinary(),
            ...processWorkerNodeExecArgv(),
            workerPath,
        ];
    }
    else {
        command = [processWorkerBunBinary(bun), workerPath];
    }
    return commandPrefix === undefined
        ? command
        : [...commandPrefix, ...command];
};
const createProcessWorkerNativeSignalNotifier = ({ processRuntime, signal, }) => {
    if (RUNTIME !== "node" || processRuntime !== "node")
        return undefined;
    try {
        const futex = loadNodeFutexAddon();
        return () => {
            futex.wakeU32(signal.buffer, signal.byteOffset, 1);
        };
    }
    catch {
        return undefined;
    }
};
const createProcessWorkerEventHub = () => {
    const messageHandlers = [];
    const errorHandlers = [];
    const exitHandlers = [];
    return {
        emitMessage: (message) => {
            for (const handler of messageHandlers)
                handler(message);
        },
        emitError: (error) => {
            for (const handler of errorHandlers)
                handler(error);
        },
        emitExit: (code) => {
            for (const handler of exitHandlers)
                handler(code);
        },
        on: (event, listener) => {
            if (event === "message")
                messageHandlers.push(listener);
            if (event === "error")
                errorHandlers.push(listener);
            if (event === "exit")
                exitHandlers.push(listener);
        },
    };
};
const spawnBunHostedProcessWorker = ({ workerUrl, bootPayload, memory, processRuntime, commandPrefix, permission, }) => {
    const bun = globalThis.Bun;
    if (typeof bun?.spawn !== "function") {
        throw new Error("Bun.spawn is not available for process workers");
    }
    const events = createProcessWorkerEventHub();
    const nodeProcess = getNodeProcess();
    const useIpcBoot = processRuntime === "bun" && commandPrefix === undefined;
    const spawnOptions = {
        cmd: processWorkerCommand({
            processRuntime,
            workerUrl,
            bun,
            commandPrefix,
            permission,
        }),
        cwd: nodeProcess?.cwd?.(),
        env: useIpcBoot
            ? processWorkerEnv()
            : processWorkerBootEnv(bootPayload),
        stdin: memory.mapping.fd,
        stdout: "inherit",
        stderr: "inherit",
        onExit: (_subprocess, exitCode, _signalCode, error) => {
            if (error !== undefined)
                events.emitError(error);
            events.emitExit(exitCode ?? -1);
        },
    };
    if (useIpcBoot) {
        spawnOptions.serialization = "advanced";
        spawnOptions.ipc = (message) => {
            events.emitMessage(message);
        };
    }
    const child = bun.spawn(spawnOptions);
    if (useIpcBoot) {
        queueMicrotask(() => child.send?.(bootPayload));
    }
    child.exited.catch((error) => {
        events.emitError(error);
    });
    return {
        terminate: () => {
            child.kill();
            return child.exited.catch(() => undefined);
        },
        on: events.on,
    };
};
const spawnNodeHostedProcessWorker = ({ workerUrl, bootPayload, memory, processRuntime, commandPrefix, permission, }) => {
    const childProcess = getNodeBuiltinModule("node:child_process");
    if (typeof childProcess?.spawn !== "function") {
        throw new Error("node:child_process.spawn is not available");
    }
    const events = createProcessWorkerEventHub();
    const useIpcBoot = processRuntime === "bun" && commandPrefix === undefined;
    const [command, ...args] = processWorkerCommand({
        processRuntime,
        workerUrl,
        commandPrefix,
        permission,
    });
    const child = childProcess.spawn(command, args, {
        cwd: getNodeProcess()?.cwd?.(),
        env: useIpcBoot
            ? processWorkerEnv()
            : processWorkerBootEnv(bootPayload),
        stdio: useIpcBoot
            ? [memory.mapping.fd, "inherit", "inherit", "ipc"]
            : [memory.mapping.fd, "inherit", "inherit"],
    });
    if (useIpcBoot) {
        child.on("message", events.emitMessage);
        queueMicrotask(() => child.send?.(bootPayload));
    }
    child.on("error", events.emitError);
    child.on("exit", (code) => events.emitExit(code ?? -1));
    return {
        terminate: () => child.kill(),
        unref: () => child.unref?.(),
        on: events.on,
    };
};
const getDenoRuntime = () => globalThis.Deno;
const denoFileRid = (file) => {
    for (const symbol of Object.getOwnPropertySymbols(file)) {
        if (String(symbol) === "Symbol(Deno.internal.rid)") {
            const rid = file[symbol];
            if (typeof rid === "number")
                return rid;
        }
    }
    throw new Error("Deno FsFile resource id is not available");
};
const openDenoInheritedFd = (fd) => {
    const deno = getDenoRuntime();
    if (typeof deno?.openSync !== "function") {
        throw new Error("Deno.openSync is not available for process workers");
    }
    const fdPath = detectPosixPlatform() === "linux"
        ? `/proc/self/fd/${fd}`
        : `/dev/fd/${fd}`;
    return deno.openSync(fdPath, { read: true, write: true });
};
const spawnDenoHostedProcessWorker = ({ workerUrl, bootPayload, memory, processRuntime, commandPrefix, permission, }) => {
    const deno = getDenoRuntime();
    if (typeof deno?.Command !== "function") {
        throw new Error("Deno.Command is not available for process workers");
    }
    const inheritedFd = openDenoInheritedFd(memory.mapping.fd);
    const events = createProcessWorkerEventHub();
    const [command, ...args] = processWorkerCommand({
        processRuntime,
        workerUrl,
        deno,
        commandPrefix,
        permission,
    });
    const child = new deno.Command(command, {
        args,
        cwd: deno.cwd?.(),
        env: stringProcessEnv(processWorkerBootEnv(bootPayload)),
        stdin: denoFileRid(inheritedFd),
        stdout: "inherit",
        stderr: "inherit",
    }).spawn();
    const closeInheritedFd = () => {
        try {
            inheritedFd.close?.();
        }
        catch {
        }
    };
    child.status.then((status) => {
        closeInheritedFd();
        events.emitExit(status.code);
    }, (error) => {
        closeInheritedFd();
        events.emitError(error);
        events.emitExit(-1);
    });
    return {
        terminate: () => {
            try {
                child.kill("SIGTERM");
            }
            catch {
            }
            return child.status.finally(closeInheritedFd);
        },
        on: events.on,
    };
};
const spawnProcessWorker = (options) => {
    switch (RUNTIME) {
        case "bun":
            return spawnBunHostedProcessWorker(options);
        case "node":
            return spawnNodeHostedProcessWorker(options);
        case "deno":
            return spawnDenoHostedProcessWorker(options);
        default:
            throw new Error("process worker runtime is only available in Node, Deno, or Bun");
    }
};
const terminateWorkerQuietly = (worker) => {
    try {
        // Runaway worker termination can be slow or stuck on some runtimes; once the
        // pool is closing it must not keep the host process alive.
        worker.unref?.();
        void Promise.resolve(worker.terminate()).catch(() => { });
    }
    catch {
    }
};
export const spawnWorkerContext = ({ list, ids, sab, thread, debug, totalNumberOfThread, source, at, workerOptions, workerExecArgv, permission, host, payload, payloadInitialBytes, payloadMaxBytes, bufferMode, maxPayloadBytes, abortSignalCapacity, usesAbortSignal, }) => {
    const tsFileUrl = new URL(import.meta.url);
    const poliWorker = RUNTIME_WORKER;
    const resolvedWorkerOptions = withDefaultWorkerTimers(workerOptions);
    const useProcessWorkerRuntime = resolvedWorkerOptions.runtime === "process";
    if (useProcessWorkerRuntime) {
        assertPosixSharedMemoryPlatform("Process worker runtime");
    }
    const processWorkerRuntime = useProcessWorkerRuntime
        ? readProcessWorkerRuntime(resolvedWorkerOptions)
        : undefined;
    const processWorkerCommandPrefix = useProcessWorkerRuntime
        ? readProcessWorkerCommandPrefix(resolvedWorkerOptions)
        : undefined;
    if (debug?.logHref === true) {
        console.log(tsFileUrl);
    }
    if (!useProcessWorkerRuntime && typeof poliWorker !== "function") {
        throw new Error("Worker is not available in this runtime");
    }
    const WorkerCtor = poliWorker;
    // Lock buffers must be shared between host and worker.
    const sanitizeBytes = (value) => {
        if (!Number.isFinite(value))
            return undefined;
        const bytes = Math.floor(value);
        return bytes > 0 ? bytes : undefined;
    };
    const basePayloadConfig = resolvePayloadBufferOptions({
        options: {
            ...payload,
            mode: payload?.mode ?? bufferMode,
            maxPayloadBytes: payload?.maxPayloadBytes ?? maxPayloadBytes,
            payloadInitialBytes: payload?.payloadInitialBytes ??
                sanitizeBytes(payloadInitialBytes),
            payloadMaxByteLength: payload?.payloadMaxByteLength ??
                sanitizeBytes(payloadMaxBytes),
        },
    });
    const resolvedPayloadConfig = useProcessWorkerRuntime
        ? withFixedPayloadConfig(basePayloadConfig)
        : basePayloadConfig;
    const defaultAbortSignalCapacity = 258;
    const requestedAbortSignalCapacity = sanitizeBytes(abortSignalCapacity);
    const resolvedAbortSignalCapacity = requestedAbortSignalCapacity ??
        defaultAbortSignalCapacity;
    const abortSignalWords = Math.max(1, Math.ceil(resolvedAbortSignalCapacity / 32));
    const requestedSignalBytes = sanitizeBytes(sab?.size);
    const externalSignalSab = sab?.sharedSab;
    if (useProcessWorkerRuntime && externalSignalSab != null) {
        throw new Error("process worker runtime cannot use an external signal buffer");
    }
    const signalBytes = Math.max(TRANSPORT_SIGNAL_BYTES, requestedSignalBytes ?? TRANSPORT_SIGNAL_BYTES);
    const abortBytes = abortSignalWords * Uint32Array.BYTES_PER_ELEMENT;
    const processWorkerMemory = useProcessWorkerRuntime
        ? createProcessWorkerMemoryLayout({
            signalBytes,
            abortBytes,
            payloadBytes: resolvedPayloadConfig.payloadMaxByteLength,
            thread,
        })
        : undefined;
    const processSharedMemory = processWorkerMemory === undefined
        ? createProcessSharedMemoryAllocator(debug)
        : undefined;
    const createControlBuffer = processSharedMemory?.createBuffer ??
        createWasmSharedArrayBuffer;
    const createPayloadBuffer = processSharedMemory?.createBuffer;
    const makePayloadBuffer = () => createPayloadBuffer
        // ProcessSharedBuffer is fixed-size today, so reserve the configured
        // payload ceiling instead of relying on SAB growth.
        ? createPayloadBuffer(resolvedPayloadConfig.payloadMaxByteLength)
        : resolvedPayloadConfig.mode === "growable"
            ? createSharedArrayBuffer(resolvedPayloadConfig.payloadInitialBytes, resolvedPayloadConfig.payloadMaxByteLength)
            : createSharedArrayBuffer(resolvedPayloadConfig.payloadInitialBytes);
    const makeLockControlLayout = () => {
        // Keep the hottest control words in one compact front strip:
        // transport signals -> request lock -> return lock.
        // Request/return headers stay in separate contiguous slabs to preserve
        // sequential batching locality.
        // Abort bitmap stays at the tail.
        return createLockControlCarpet({
            signalBytes,
            abortBytes,
            lockSectorBytes: LOCK_SECTOR_BYTE_LENGTH,
            headerSlotStrideU32: HEADER_SLOT_STRIDE_U32,
            slotCount: LockBound.slots,
            headerLayout: "split",
            createBuffer: createControlBuffer,
        });
    };
    const controlLayout = processWorkerMemory?.controlLayout ??
        makeLockControlLayout();
    const lockPayload = processWorkerMemory?.lockPayload ?? makePayloadBuffer();
    const lockBuffers = {
        ...controlLayout.lock,
        payload: lockPayload,
        textCompat: probeLockBufferTextCompat({
            headers: controlLayout.lock.headers,
            payload: lockPayload,
        }),
    };
    const returnPayload = processWorkerMemory?.returnPayload ??
        makePayloadBuffer();
    const returnLockBuffers = {
        ...controlLayout.returnLock,
        payload: returnPayload,
        textCompat: probeLockBufferTextCompat({
            headers: controlLayout.returnLock.headers,
            payload: returnPayload,
        }),
    };
    const lock = lock2({
        headers: lockBuffers.headers,
        headerSlotStrideU32: lockBuffers.headerSlotStrideU32,
        LockBoundSector: lockBuffers.lockSector,
        payload: lockBuffers.payload,
        payloadSector: lockBuffers.payloadSector,
        payloadConfig: resolvedPayloadConfig,
        textCompat: lockBuffers.textCompat,
    });
    const returnLock = lock2({
        headers: returnLockBuffers.headers,
        headerSlotStrideU32: returnLockBuffers.headerSlotStrideU32,
        LockBoundSector: returnLockBuffers.lockSector,
        payload: returnLockBuffers.payload,
        payloadSector: returnLockBuffers.payloadSector,
        payloadConfig: resolvedPayloadConfig,
        textCompat: returnLockBuffers.textCompat,
    });
    const abortSignalSAB = usesAbortSignal === true
        ? controlLayout.abortSignals
        : undefined;
    const abortSignals = abortSignalSAB
        ? signalAbortFactory({
            sab: abortSignalSAB,
            maxSignals: resolvedAbortSignalCapacity,
        })
        : undefined;
    const signals = createSharedMemoryTransport({
        sabObject: externalSignalSab == null
            ? {
                size: requestedSignalBytes,
                sharedSab: controlLayout.signals,
            }
            : sab,
        isMain: true,
        thread,
        debug,
    });
    const signalBox = signals;
    const nativeNotifySignal = createProcessWorkerNativeSignalNotifier({
        processRuntime: processWorkerRuntime,
        signal: signalBox.opView,
    });
    const queue = createHostTxQueue({
        lock,
        returnLock,
        abortSignals,
    });
    const { enqueue, rejectAll, txIdle, } = queue;
    const channelHandler = new ChannelHandler();
    const { check } = hostDispatcherLoop({
        signalBox,
        queue,
        channelHandler,
        dispatcherOptions: host,
        notifySignal: nativeNotifySignal,
        //thread,
        //debugSignal: debug?.logMain ?? false,
        //perf,
    });
    channelHandler.open(check);
    let worker;
    const workerUrl = source ?? tsFileUrl;
    const workerDataPayload = {
        sab: signals.sab,
        abortSignalSAB,
        abortSignalMax: usesAbortSignal === true
            ? resolvedAbortSignalCapacity
            : undefined,
        list,
        ids,
        at,
        thread,
        debug,
        workerOptions: resolvedWorkerOptions,
        totalNumberOfThread,
        startAt: signalBox.startAt,
        lock: lockBuffers,
        returnLock: returnLockBuffers,
        payloadConfig: resolvedPayloadConfig,
        permission,
    };
    const baseWorkerOptions = {
        //@ts-ignore Reason
        type: "module",
        //@ts-ignore
        workerData: workerDataPayload,
    };
    const withExecArgv = workerExecArgv && workerExecArgv.length > 0
        ? { ...baseWorkerOptions, execArgv: workerExecArgv }
        : baseWorkerOptions;
    if (processWorkerMemory !== undefined) {
        worker = spawnProcessWorker({
            workerUrl,
            bootPayload: toProcessWorkerBootPayload(workerDataPayload, processWorkerMemory),
            memory: processWorkerMemory,
            processRuntime: processWorkerRuntime,
            commandPrefix: processWorkerCommandPrefix,
            permission,
        });
    }
    else if (HAS_NODE_WORKER_THREADS) {
        try {
            worker = new WorkerCtor(workerUrl, withExecArgv);
        }
        catch (error) {
            if (error?.code === "ERR_WORKER_INVALID_EXEC_ARGV") {
                const fallbackExecArgv = toWorkerSafeExecArgv(withExecArgv.execArgv);
                if (fallbackExecArgv && fallbackExecArgv.length > 0) {
                    try {
                        worker = new WorkerCtor(workerUrl, { ...baseWorkerOptions, execArgv: fallbackExecArgv });
                    }
                    catch (fallbackError) {
                        if (fallbackError?.code ===
                            "ERR_WORKER_INVALID_EXEC_ARGV") {
                            const compatExecArgv = toWorkerCompatExecArgv(fallbackExecArgv);
                            if (compatExecArgv && compatExecArgv.length > 0) {
                                try {
                                    worker = new WorkerCtor(workerUrl, { ...baseWorkerOptions, execArgv: compatExecArgv });
                                }
                                catch {
                                    worker = new WorkerCtor(workerUrl, baseWorkerOptions);
                                }
                            }
                            else {
                                worker = new WorkerCtor(workerUrl, baseWorkerOptions);
                            }
                        }
                        else {
                            throw fallbackError;
                        }
                    }
                }
                else {
                    worker = new WorkerCtor(workerUrl, baseWorkerOptions);
                }
            }
            else {
                throw error;
            }
        }
    }
    else {
        worker = new WorkerCtor(workerUrl, {
            type: "module",
        });
        worker.postMessage?.(workerDataPayload);
    }
    let closedReason;
    const markWorkerClosed = (reason) => {
        if (closedReason)
            return;
        closedReason = reason;
        rejectAll(reason);
        channelHandler.close();
    };
    const onWorkerMessage = (message) => {
        if (!isWorkerFatalMessage(message))
            return;
        markWorkerClosed(`Worker startup failed: ${message[WORKER_FATAL_MESSAGE_KEY]}`);
        terminateWorkerQuietly(worker);
    };
    const onWorkerError = (error) => {
        const message = String(error?.message ?? error);
        markWorkerClosed(`Worker crashed: ${message}`);
    };
    const nodeWorker = worker;
    if (typeof nodeWorker.on === "function") {
        nodeWorker.on("message", onWorkerMessage);
        nodeWorker.on("error", onWorkerError);
        nodeWorker.on("exit", (code) => {
            if (typeof code === "number" && code === 0)
                return;
            const normalized = typeof code === "number" ? code : -1;
            markWorkerClosed(`Worker exited with code ${normalized}`);
        });
    }
    else {
        const eventWorker = worker;
        if (typeof eventWorker.addEventListener === "function") {
            eventWorker.addEventListener("message", (event) => {
                onWorkerMessage(event?.data);
            });
            eventWorker.addEventListener("error", (event) => {
                onWorkerError(event?.error ?? event?.message ?? event);
            });
        }
        else {
            eventWorker.onmessage = (event) => {
                onWorkerMessage(event?.data);
            };
            eventWorker.onerror = (event) => {
                onWorkerError(event);
            };
        }
    }
    const thisSignal = signalBox.opView;
    const a_add = Atomics.add;
    const a_load = Atomics.load;
    const a_notify = Atomics.notify;
    const canNotifySignal = thisSignal.buffer instanceof SharedArrayBuffer;
    const notifySignal = nativeNotifySignal ??
        (canNotifySignal ? (() => a_notify(thisSignal, 0, 1)) : undefined);
    //const scheduleFastCheck = queueMicrotask;
    const send = () => {
        if (check.isRunning === true)
            return;
        check.isRunning = true;
        Promise.resolve().then(check);
        // Macro lane: dispatcher check is driven by the channel callback.
        // channelHandler.notify();
        // Use opView as a wake counter in lock2 mode to avoid lost wakeups.
        if (a_load(signalBox.rxStatus, 0) === 0) {
            a_add(thisSignal, 0, 1);
            notifySignal?.();
        }
    };
    lock.setPromiseHandler((task, isRejected, value) => {
        queue.settlePromisePayload(task, isRejected, value);
        send();
    });
    const call = ({ fnNumber, timeout, abortSignal }) => {
        const enqueues = enqueue(fnNumber, timeout, abortSignal);
        return (args) => {
            const pending = enqueues(args);
            send();
            return pending;
        };
    };
    const context = {
        txIdle,
        call,
        kills: async () => {
            markWorkerClosed("Thread closed");
            terminateWorkerQuietly(worker);
        },
        lock,
        processSharedMemoryBackings: processSharedMemory?.backings,
    };
    return context;
};
