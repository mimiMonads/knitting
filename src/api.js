var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { getCallerFilePath } from "./common/task-source.js";
import { genTaskID } from "./common/task-source.js";
import { toModuleUrl } from "./common/module-url.js";
import { endpointSymbol } from "./common/task-symbol.js";
import { spawnWorkerContext } from "./runtime/pool.js";
import { RUNTIME_IS_MAIN_THREAD, RUNTIME_WORKER_DATA, } from "./common/worker-runtime.js";
import { resolvePermissionProtocol, toRuntimePermissionFlags, } from "./permission/index.js";
import { getNodeProcess } from "./common/node-compat.js";
import { managerMethod } from "./runtime/balancer.js";
import { createInlineExecutor } from "./runtime/inline-executor.js";
const MAX_FUNCTION_ID = 0xFFFF;
const MAX_FUNCTION_COUNT = MAX_FUNCTION_ID + 1;
export const isMain = RUNTIME_IS_MAIN_THREAD;
export { endpointSymbol as endpointSymbol };
/**
 *  With this information we can recreate the logical order of
 *  relevant exported functions from a file, also it helps to
 *  track a task before naming, ` export ` elements have to be declared
 *  at top level and without branching, we take advantage of this to
 *  correctly map them.
 *
 */
export const toListAndIds = (args) => {
    const result = Object.values(args)
        .reduce((acc, v) => (acc[0].add(v.importedFrom),
        acc[1].add(v.id),
        acc[2].add(v.at),
        acc), [
        new Set(),
        new Set(),
        new Set()
    ]);
    return {
        list: [...result[0]],
        ids: [...result[1]],
        at: [...result[2]],
    };
};
export const createPool = ({ threads, debug, inliner, balancer, payload, payloadInitialBytes, payloadMaxBytes, bufferMode, maxPayloadBytes, abortSignalCapacity, source, worker, workerExecArgv, permission, dispatcher, host, }) => (tasks) => {
    /**
     *  This functions is only available in the main thread.
     *  Also triggers when debug extra is enabled.
     */
    if (RUNTIME_IS_MAIN_THREAD === false) {
        if ((debug?.extras === true)) {
            console.warn("createPool has been called with : " + JSON.stringify(RUNTIME_WORKER_DATA));
        }
        const notMainThreadError = () => {
            throw new Error("createPool can only be called in the main thread.");
        };
        const throwingProxyTarget = function () {
            return notMainThreadError();
        };
        const throwingProxyHandler = {
            get: function () {
                return notMainThreadError;
            },
        };
        const mainThreadOnlyProxy = new Proxy(throwingProxyTarget, throwingProxyHandler);
        //@ts-ignore
        return {
            shutdown: mainThreadOnlyProxy,
            call: mainThreadOnlyProxy,
        };
    }
    const { list, ids, at } = toListAndIds(tasks), listOfFunctions = Object.entries(tasks).map(([k, v]) => ({
        ...v,
        name: k,
    }))
        .sort((a, b) => a.name.localeCompare(b.name));
    if (listOfFunctions.length > MAX_FUNCTION_COUNT) {
        throw new RangeError(`Too many tasks: received ${listOfFunctions.length}. ` +
            `Maximum is ${MAX_FUNCTION_COUNT} (Uint16 function IDs: 0..${MAX_FUNCTION_ID}).`);
    }
    const usingInliner = typeof inliner === "object" && inliner != null;
    const totalNumberOfThread = (threads ?? 1) +
        (usingInliner ? 1 : 0);
    const permissionProtocol = resolvePermissionProtocol({
        permission: permission ?? {
            mode: "strict",
            allowImport: true,
        },
        modules: list,
    });
    const permissionExecArgv = toRuntimePermissionFlags(permissionProtocol);
    const nodeProcess = getNodeProcess();
    const allowedFlags = nodeProcess?.allowedNodeEnvironmentFlags ?? null;
    const isNodePermissionFlag = (flag) => {
        const key = flag.split("=", 1)[0];
        return key === "--permission" ||
            key === "--experimental-permission" ||
            key === "--allow-fs-read" ||
            key === "--allow-fs-write" ||
            key === "--allow-worker" ||
            key === "--allow-child-process" ||
            key === "--allow-addons" ||
            key === "--allow-wasi";
    };
    const stripNodePermissionFlags = (flags) => flags?.filter((flag) => !isNodePermissionFlag(flag));
    const dedupeFlags = (flags) => {
        const out = [];
        const seen = new Set();
        for (const flag of flags) {
            if (seen.has(flag))
                continue;
            seen.add(flag);
            out.push(flag);
        }
        return out;
    };
    const sanitizeExecArgv = (flags) => {
        if (!flags || flags.length === 0)
            return undefined;
        if (!allowedFlags)
            return flags;
        const filtered = flags.filter((flag) => {
            const key = flag.split("=", 1)[0];
            return allowedFlags.has(key);
        });
        return filtered.length > 0 ? filtered : undefined;
    };
    const inheritedExecArgv = Array.isArray(nodeProcess?.execArgv)
        ? nodeProcess.execArgv
        : undefined;
    const defaultExecArgvCandidate = workerExecArgv ??
        (inheritedExecArgv
            ? (allowedFlags?.has("--expose-gc") === true
                ? (inheritedExecArgv.includes("--expose-gc")
                    ? inheritedExecArgv
                    : [...inheritedExecArgv, "--expose-gc"])
                : inheritedExecArgv)
            : undefined);
    const defaultExecArgv = permissionProtocol?.unsafe === true
        ? stripNodePermissionFlags(defaultExecArgvCandidate)
        : defaultExecArgvCandidate;
    const combinedExecArgv = dedupeFlags([
        ...permissionExecArgv,
        ...(defaultExecArgv ?? []),
    ]);
    const execArgv = sanitizeExecArgv(combinedExecArgv.length > 0 ? combinedExecArgv : undefined);
    const hostDispatcher = host ?? dispatcher;
    const usesAbortSignal = listOfFunctions.some((fn) => fn.abortSignal !== undefined);
    const hardTimeoutMs = Number.isFinite(worker?.hardTimeoutMs)
        ? Math.max(1, Math.floor(worker?.hardTimeoutMs))
        : undefined;
    let workers = Array.from({
        length: threads ?? 1,
    }).map((_, thread) => spawnWorkerContext({
        list,
        ids,
        at,
        thread,
        debug,
        totalNumberOfThread,
        source,
        workerOptions: worker,
        workerExecArgv: execArgv,
        host: hostDispatcher,
        payload,
        payloadInitialBytes,
        payloadMaxBytes,
        bufferMode,
        maxPayloadBytes,
        abortSignalCapacity,
        usesAbortSignal,
        permission: permissionProtocol,
    }));
    if (usingInliner) {
        const mainThread = createInlineExecutor({
            tasks,
            genTaskID,
            batchSize: inliner?.batchSize ?? 1,
        });
        if (inliner?.position === "first") {
            workers = [
                //@ts-ignore
                mainThread,
                ...workers,
            ];
        }
        else {
            workers.push(
            //@ts-ignore
            mainThread);
        }
    }
    const inlinerIndex = usingInliner
        ? (inliner?.position === "first" ? 0 : workers.length - 1)
        : -1;
    const inlinerDispatchThreshold = Number.isFinite(inliner?.dispatchThreshold)
        ? Math.max(1, Math.floor(inliner?.dispatchThreshold ?? 1))
        : 1;
    let closing = false;
    let closePromise;
    let shutdownPromise;
    const closePoolNow = () => {
        if (closePromise)
            return closePromise;
        closing = true;
        closePromise = Promise.allSettled(workers.map((context) => context.kills()))
            .then(() => undefined);
        return closePromise;
    };
    const wrapGuardedInvoke = ({ invoke, taskName, }) => (args) => {
        if (closing) {
            return Promise.reject(new Error("Pool is shut down"));
        }
        const pending = invoke(args);
        if (!hardTimeoutMs)
            return pending;
        return new Promise((resolve, reject) => {
            let settled = false;
            const timeoutId = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                reject(new Error(`Task hard timeout after ${hardTimeoutMs}ms (${taskName}); pool force-shutdown`));
                void closePoolNow();
            }, hardTimeoutMs);
            pending.then((value) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeoutId);
                resolve(value);
            }, (error) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeoutId);
                reject(error);
            });
        });
    };
    const shutdownWithDelay = (delayMs) => {
        if (closePromise)
            return closePromise;
        if (shutdownPromise)
            return shutdownPromise;
        const ms = Number.isFinite(delayMs)
            ? Math.max(0, Math.floor(delayMs))
            : 0;
        shutdownPromise = (async () => {
            if (closePromise)
                return await closePromise;
            if (ms > 0) {
                await new Promise((resolve) => setTimeout(resolve, ms));
            }
            if (closePromise)
                return await closePromise;
            await closePoolNow();
        })();
        return shutdownPromise;
    };
    const indexedFunctions = listOfFunctions.map((fn, index) => ({
        name: fn.name,
        index,
        timeout: fn.timeout,
        abortSignal: fn.abortSignal,
    }));
    const callHandlers = new Map();
    for (const { name } of indexedFunctions) {
        callHandlers.set(name, []);
    }
    for (const worker of workers) {
        for (const { name, index, timeout, abortSignal } of indexedFunctions) {
            callHandlers.get(name).push(wrapGuardedInvoke({
                taskName: name,
                invoke: worker.call({
                    fnNumber: index,
                    timeout,
                    abortSignal,
                }),
            }));
        }
    }
    const useDirectHandler = (threads ?? 1) === 1 && !usingInliner;
    const buildInvoker = (handlers) => useDirectHandler
        ? handlers[0]
        : managerMethod({
            contexts: workers,
            balancer,
            handlers,
            inlinerGate: usingInliner
                ? {
                    index: inlinerIndex,
                    threshold: inlinerDispatchThreshold,
                }
                : undefined,
        });
    const callEntries = Array.from(callHandlers.entries(), ([name, handlers]) => [name, buildInvoker(handlers)]);
    return {
        shutdown: shutdownWithDelay,
        call: Object.fromEntries(callEntries),
    };
};
const SINGLE_TASK_KEY = "__task__";
const DEFAULT_IMPORT_EXPORT_NAME = "default";
const createSingleTaskPool = (single, options) => {
    const pool = createPool(options ?? {})({
        [SINGLE_TASK_KEY]: single,
    });
    return {
        call: pool.call[SINGLE_TASK_KEY],
        shutdown: pool.shutdown,
    };
};
const buildTaskDefinitionFromCaller = (input, callerHref, at) => {
    const importedFrom = new URL(callerHref).href;
    const out = ({
        ...input,
        id: genTaskID(),
        importedFrom,
        at,
        [endpointSymbol]: true,
    });
    out.createPool = (options) => {
        if (RUNTIME_IS_MAIN_THREAD === false) {
            return out;
        }
        return createSingleTaskPool(out, options);
    };
    return out;
};
const buildTaskDefinition = (input, callerOffset) => {
    const [href, at] = getCallerFilePath(callerOffset);
    return buildTaskDefinitionFromCaller(input, href, at);
};
const resolveImportHref = (href, callerHref) => {
    try {
        return new URL(href, callerHref).href;
    }
    catch {
        return toModuleUrl(href);
    }
};
const createImportedTaskFn = (href, exportName) => {
    let cachedFn;
    let cachedLoad;
    const loadFn = async () => {
        if (cachedFn)
            return cachedFn;
        if (!cachedLoad) {
            cachedLoad = import(__rewriteRelativeImportExtension(href)).then((module) => {
                const record = module;
                const selected = exportName === DEFAULT_IMPORT_EXPORT_NAME
                    ? record.default
                    : record[exportName];
                if (typeof selected !== "function") {
                    const available = Object.keys(record).join(", ");
                    throw new TypeError(`importTask expected export "${exportName}" from "${href}" to be a function.` +
                        ` Available exports: ${available || "(none)"}`);
                }
                cachedFn = selected;
                return cachedFn;
            });
        }
        return cachedLoad;
    };
    return (async (...args) => {
        const fn = await loadFn();
        return fn(...args);
    });
};
export function task(I) {
    return buildTaskDefinition(I, 4);
}
export function importTask(options) {
    const [callerHref, at] = getCallerFilePath(3);
    const { href, name = DEFAULT_IMPORT_EXPORT_NAME, ...rest } = options;
    const resolvedHref = resolveImportHref(href, callerHref);
    return buildTaskDefinitionFromCaller({
        ...rest,
        f: createImportedTaskFn(resolvedHref, name),
    }, callerHref, at);
}
