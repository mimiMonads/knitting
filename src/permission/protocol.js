import { existsSync as existsSyncCompat, realpathSync as realpathSyncCompat, } from "node:fs";
import { isAbsolute as pathIsAbsolute, relative as pathRelative, resolve as pathResolve, } from "node:path";
import { fileURLToPath as fileURLToPathCompat } from "node:url";
import { RUNTIME } from "../common/runtime.js";
import { toCanonicalPath as toSharedCanonicalPath } from "../common/path-canonical.js";
import { getNodeProcess } from "../common/node-compat.js";
const DEFAULT_ENV_FILE = ".env";
const DEFAULT_DENO_LOCK_FILE = "deno.lock";
const NODE_MODULES_DIR = "node_modules";
const DEFAULT_DENY_RELATIVE = [
    ".env",
    ".git",
    ".npmrc",
    ".docker",
    ".secrets",
];
const DEFAULT_ALLOW_IMPORT_HOSTS = ["deno.land", "esm.sh", "jsr.io"];
const SUPPORTED_SYS_API_NAMES = [
    "hostname",
    "osRelease",
    "osUptime",
    "loadavg",
    "networkInterfaces",
    "systemMemoryInfo",
    "uid",
    "gid",
];
const SUPPORTED_SYS_API_NAME_SET = new Set(SUPPORTED_SYS_API_NAMES);
const L3_KEYS = {
    deno: [],
    node: [
        "denyRead",
        "denyWrite",
        "net",
        "denyNet",
        "env.allow",
        "env.deny",
        "denyRun",
        "denyFfi",
        "sys",
        "denySys",
        "allowImport",
    ],
};
const cloneL3Keys = () => ({
    deno: [...L3_KEYS.deno],
    node: [...L3_KEYS.node],
});
const DEFAULT_DENY_HOME = [
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".config/gcloud",
    ".kube",
];
const DEFAULT_DENY_ABSOLUTE_POSIX = [
    "/proc",
    "/proc/self",
    "/proc/self/environ",
    "/proc/self/mem",
    "/sys",
    "/dev",
    "/etc",
];
const normalizeList = (values) => {
    const out = [];
    const seen = new Set();
    for (const value of values) {
        if (seen.has(value))
            continue;
        seen.add(value);
        out.push(value);
    }
    return out;
};
const normalizeStringList = (values) => {
    if (!values || values.length === 0)
        return [];
    const cleaned = [];
    for (const value of values) {
        if (typeof value !== "string")
            continue;
        const trimmed = value.trim();
        if (trimmed.length === 0)
            continue;
        cleaned.push(trimmed);
    }
    return normalizeList(cleaned);
};
const normalizeSysApiList = (values) => {
    if (!values || values.length === 0)
        return [];
    const out = [];
    const seen = new Set();
    for (const raw of values) {
        if (typeof raw !== "string")
            continue;
        const value = raw.trim();
        if (value.length === 0 || seen.has(value))
            continue;
        if (!SUPPORTED_SYS_API_NAME_SET.has(value))
            continue;
        seen.add(value);
        out.push(value);
    }
    return out;
};
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const normalizeProtocolInput = (input) => !input ? undefined : (typeof input === "string" ? { mode: input } : input);
const isWindows = () => {
    const nodeProcess = getNodeProcess();
    if (typeof nodeProcess?.platform === "string")
        return nodeProcess.platform === "win32";
    const g = globalThis;
    return g.Deno?.build?.os === "windows";
};
const getCwd = () => {
    try {
        const nodeProcess = getNodeProcess();
        if (typeof nodeProcess?.cwd === "function") {
            return nodeProcess.cwd();
        }
    }
    catch {
    }
    const g = globalThis;
    try {
        if (typeof g.Deno?.cwd === "function")
            return g.Deno.cwd();
    }
    catch {
    }
    return ".";
};
const getHome = () => {
    try {
        const nodeProcess = getNodeProcess();
        if (typeof nodeProcess?.env === "object") {
            const home = nodeProcess.env.HOME ?? nodeProcess.env.USERPROFILE;
            if (typeof home === "string" && home.length > 0)
                return home;
        }
    }
    catch {
    }
    const g = globalThis;
    try {
        const home = g.Deno?.env?.get?.("HOME") ?? g.Deno?.env?.get?.("USERPROFILE");
        if (typeof home === "string" && home.length > 0)
            return home;
    }
    catch {
    }
    return undefined;
};
const expandHomePath = (value, home) => {
    if (!home)
        return value;
    if (value === "~")
        return home;
    if (value.startsWith("~/") || value.startsWith("~\\")) {
        return pathResolve(home, value.slice(2));
    }
    return value;
};
const toAbsolutePath = (value, cwd, home) => {
    if (value instanceof URL) {
        if (value.protocol !== "file:")
            return undefined;
        return pathResolve(fileURLToPathCompat(value));
    }
    const expanded = expandHomePath(value, home);
    if (pathIsAbsolute(expanded)) {
        return pathResolve(expanded);
    }
    try {
        const parsed = new URL(expanded);
        if (parsed.protocol !== "file:")
            return undefined;
        return pathResolve(fileURLToPathCompat(parsed));
    }
    catch {
        return pathResolve(cwd, expanded);
    }
};
const toPath = (value, cwd, home) => value == null ? undefined : toAbsolutePath(value, cwd, home);
const toPathList = (values, cwd, home) => {
    if (!values?.length)
        return [];
    const out = [];
    for (const value of values) {
        const resolved = toPath(value, cwd, home);
        if (resolved)
            out.push(resolved);
    }
    return out;
};
const toUniquePathList = (values, cwd, home) => normalizeList(toPathList(values, cwd, home));
const toEnvFiles = (input, cwd, home) => {
    const values = Array.isArray(input) ? input : input ? [input] : [DEFAULT_ENV_FILE];
    return toUniquePathList(values, cwd, home);
};
const rawRealpathSync = realpathSyncCompat.native ?? realpathSyncCompat;
const toCanonicalPath = (candidate) => {
    return toSharedCanonicalPath(candidate, {
        existsSync: existsSyncCompat,
        realpathSync: rawRealpathSync,
    });
};
const isPathWithin = (base, candidate) => {
    const canonicalBase = toCanonicalPath(base);
    const canonicalCandidate = toCanonicalPath(candidate);
    const relative = pathRelative(canonicalBase, canonicalCandidate);
    return relative === "" || (!relative.startsWith("..") && !pathIsAbsolute(relative));
};
const defaultSensitiveProjectAndHomePaths = (cwd, home) => {
    const projectSensitive = DEFAULT_DENY_RELATIVE.map((entry) => pathResolve(cwd, entry));
    const homeSensitive = home
        ? DEFAULT_DENY_HOME.map((entry) => pathResolve(home, entry))
        : [];
    return normalizeList([...projectSensitive, ...homeSensitive]);
};
const defaultSensitiveReadDenyPaths = (cwd, home) => {
    const projectAndHome = defaultSensitiveProjectAndHomePaths(cwd, home);
    const osSensitive = isWindows()
        ? []
        : DEFAULT_DENY_ABSOLUTE_POSIX.map((entry) => pathResolve(entry));
    return normalizeList([...projectAndHome, ...osSensitive]);
};
const collectWritePaths = (cwd, values) => {
    const out = normalizeList(values.length > 0 ? values : [cwd]);
    if (!out.some((entry) => isPathWithin(entry, cwd) || isPathWithin(cwd, entry))) {
        out.unshift(cwd);
    }
    return normalizeList(out);
};
const collectReadPaths = ({ cwd, read, moduleFiles, envFiles, denoLock, }) => {
    const out = [
        cwd,
        pathResolve(cwd, NODE_MODULES_DIR),
        ...read,
        ...moduleFiles,
        ...envFiles,
    ];
    if (denoLock)
        out.push(denoLock);
    return normalizeList(out);
};
const resolveDenoLock = (input, cwd, home) => {
    if (input === false)
        return undefined;
    if (input && input !== true) {
        return toPath(input, cwd, home);
    }
    return pathResolve(cwd, DEFAULT_DENO_LOCK_FILE);
};
const resolveNodePermissionActivationFlag = () => {
    try {
        const raw = getNodeProcess()?.versions?.node;
        const major = Number.parseInt(String(raw).split(".", 1)[0] ?? "", 10);
        if (Number.isFinite(major) && major > 0 && major < 22) {
            return "--experimental-permission";
        }
    }
    catch {
    }
    return "--permission";
};
const toNodeFlags = ({ read, readAll, write, writeAll, envFiles, node, }) => {
    const modelFlags = [];
    if (readAll) {
        modelFlags.push("--allow-fs-read=*");
    }
    else if (read.length > 0) {
        modelFlags.push(`--allow-fs-read=${read.join(",")}`);
    }
    if (writeAll) {
        modelFlags.push("--allow-fs-write=*");
    }
    else if (write.length > 0) {
        modelFlags.push(`--allow-fs-write=${write.join(",")}`);
    }
    if (node.allowWorker)
        modelFlags.push("--allow-worker");
    if (node.allowChildProcess)
        modelFlags.push("--allow-child-process");
    if (node.allowAddons)
        modelFlags.push("--allow-addons");
    if (node.allowWasi)
        modelFlags.push("--allow-wasi");
    const flags = [];
    if (modelFlags.length > 0) {
        flags.push(resolveNodePermissionActivationFlag(), ...modelFlags);
    }
    for (const file of envFiles) {
        flags.push(`--env-file-if-exists=${file}`);
    }
    return flags;
};
const toDenoFlags = ({ read, readAll, write, writeAll, denyRead, denyWrite, net, netAll, denyNet, allowImport, allowImportAll, envAllow, envAllowAll, envDeny, envFiles, run, runAll, denyRun, ffi, ffiAll, denyFfi, sys, sysAll, denySys, denoLock, denoLockEnabled, frozen, }) => {
    const flags = [];
    if (readAll) {
        flags.push("--allow-read");
    }
    else if (read.length > 0) {
        flags.push(`--allow-read=${read.join(",")}`);
    }
    if (writeAll) {
        flags.push("--allow-write");
    }
    else if (write.length > 0) {
        flags.push(`--allow-write=${write.join(",")}`);
    }
    if (denyRead.length > 0) {
        flags.push(`--deny-read=${denyRead.join(",")}`);
    }
    if (denyWrite.length > 0) {
        flags.push(`--deny-write=${denyWrite.join(",")}`);
    }
    if (netAll) {
        flags.push("--allow-net");
    }
    else if (net.length > 0) {
        flags.push(`--allow-net=${net.join(",")}`);
    }
    if (denyNet.length > 0) {
        flags.push(`--deny-net=${denyNet.join(",")}`);
    }
    if (allowImportAll) {
        flags.push("--allow-import");
    }
    else if (allowImport.length > 0) {
        flags.push(`--allow-import=${allowImport.join(",")}`);
    }
    if (envAllowAll) {
        flags.push("--allow-env");
    }
    else if (envAllow.length > 0) {
        flags.push(`--allow-env=${envAllow.join(",")}`);
    }
    if (envDeny.length > 0) {
        flags.push(`--deny-env=${envDeny.join(",")}`);
    }
    for (const file of envFiles) {
        flags.push(`--env-file=${file}`);
    }
    if (runAll) {
        flags.push("--allow-run");
    }
    else if (run.length > 0) {
        flags.push(`--allow-run=${run.join(",")}`);
    }
    if (denyRun.length > 0) {
        flags.push(`--deny-run=${denyRun.join(",")}`);
    }
    if (ffiAll) {
        flags.push("--allow-ffi");
    }
    else if (ffi.length > 0) {
        flags.push(`--allow-ffi=${ffi.join(",")}`);
    }
    if (denyFfi.length > 0) {
        flags.push(`--deny-ffi=${denyFfi.join(",")}`);
    }
    if (sysAll) {
        flags.push("--allow-sys");
    }
    else if (sys.length > 0) {
        flags.push(`--allow-sys=${sys.join(",")}`);
    }
    if (denySys.length > 0) {
        flags.push(`--deny-sys=${denySys.join(",")}`);
    }
    if (!denoLockEnabled) {
        flags.push("--no-lock");
    }
    else if (denoLock) {
        flags.push(`--lock=${denoLock}`);
        if (frozen)
            flags.push("--frozen=true");
    }
    return flags;
};
export const resolvePermissionProtocol = ({ permission, modules, }) => {
    const input = normalizeProtocolInput(permission);
    if (!input)
        return undefined;
    const rawMode = input.mode;
    const mode = (rawMode === "unsafe" || rawMode === "off")
        ? "unsafe"
        : (rawMode === "custom" ? "custom" : "strict");
    const unsafe = mode === "unsafe";
    const allowConsole = input.console ?? unsafe;
    const cwd = pathResolve(input.cwd ?? getCwd());
    const home = getHome();
    const envFiles = toEnvFiles(input.env?.files, cwd, home);
    const moduleFiles = toUniquePathList(modules, cwd, home);
    const denoLockInput = input.deno?.lock;
    const denoLockEnabled = denoLockInput !== false;
    const denoLock = resolveDenoLock(denoLockInput, cwd, home);
    if (unsafe) {
        return {
            enabled: true,
            mode,
            unsafe: true,
            allowConsole,
            cwd,
            read: [],
            readAll: true,
            write: [],
            writeAll: true,
            denyRead: [],
            denyWrite: [],
            net: [],
            netAll: true,
            denyNet: [],
            allowImport: [],
            allowImportAll: true,
            env: {
                allow: [],
                allowAll: true,
                deny: [],
                files: envFiles,
            },
            envFiles,
            run: [],
            runAll: true,
            denyRun: [],
            workers: true,
            ffi: [],
            ffiAll: true,
            denyFfi: [],
            sys: [],
            sysAll: true,
            denySys: [],
            wasi: true,
            lockFiles: {
                deno: denoLock,
            },
            node: {
                allowWorker: true,
                allowChildProcess: true,
                allowAddons: true,
                allowWasi: true,
                flags: [],
            },
            deno: {
                frozen: false,
                allowRun: true,
                flags: [],
            },
            l3: cloneL3Keys(),
        };
    }
    const nodeModulesPath = pathResolve(cwd, NODE_MODULES_DIR);
    const hasExplicitDenyRead = hasOwn(input, "denyRead");
    const hasExplicitDenyWrite = hasOwn(input, "denyWrite");
    const hasExplicitRead = hasOwn(input, "read");
    const hasExplicitWrite = hasOwn(input, "write");
    const denyReadDefaults = defaultSensitiveReadDenyPaths(cwd, home);
    const denyWriteDefaults = normalizeList([
        ...defaultSensitiveProjectAndHomePaths(cwd, home),
        nodeModulesPath,
    ]);
    const denyRead = normalizeList([
        ...toPathList(input.denyRead, cwd, home),
        ...((mode === "custom" && hasExplicitDenyRead) ? [] : denyReadDefaults),
    ]);
    const denyWrite = normalizeList([
        ...toPathList(input.denyWrite, cwd, home),
        ...((mode === "custom" && hasExplicitDenyWrite) ? [] : denyWriteDefaults),
    ]);
    const readAll = input.read === true;
    const writeAll = input.write === true;
    const configuredRead = readAll
        ? []
        : toPathList(Array.isArray(input.read) ? input.read : undefined, cwd, home);
    const configuredWrite = writeAll
        ? []
        : toPathList(Array.isArray(input.write) ? input.write : undefined, cwd, home);
    const resolvedRead = readAll
        ? []
        : hasExplicitRead
            ? normalizeList(configuredRead)
            : collectReadPaths({
                cwd,
                read: configuredRead,
                moduleFiles,
                envFiles,
                denoLock,
            });
    const resolvedWrite = writeAll
        ? []
        : hasExplicitWrite
            ? normalizeList(configuredWrite)
            : collectWritePaths(cwd, configuredWrite);
    const netAll = input.net === true;
    const net = netAll
        ? []
        : normalizeStringList(Array.isArray(input.net) ? input.net : []);
    const denyNet = normalizeStringList(input.denyNet);
    const allowImportAll = input.allowImport === true;
    const allowImport = allowImportAll
        ? []
        : normalizeStringList(Array.isArray(input.allowImport)
            ? input.allowImport
            : [...DEFAULT_ALLOW_IMPORT_HOSTS]);
    const envAllowAll = input.env?.allow === true;
    const envAllow = envAllowAll
        ? []
        : normalizeStringList(Array.isArray(input.env?.allow) ? input.env.allow : []);
    const envDeny = normalizeStringList(input.env?.deny);
    const legacyRunEnabled = input.node?.allowChildProcess === true ||
        input.deno?.allowRun === true;
    const runSource = hasOwn(input, "run") ? input.run : (legacyRunEnabled ? true : []);
    const runAll = runSource === true;
    const run = runAll
        ? []
        : normalizeStringList(Array.isArray(runSource) ? runSource : []);
    const denyRun = normalizeStringList(input.denyRun);
    const workers = hasOwn(input, "workers")
        ? input.workers === true
        : input.node?.allowWorker === true;
    const ffiSource = hasOwn(input, "ffi")
        ? input.ffi
        : (input.node?.allowAddons === true ? true : false);
    const ffiAll = ffiSource === true;
    const ffi = ffiAll
        ? []
        : toUniquePathList(Array.isArray(ffiSource) ? ffiSource : undefined, cwd, home);
    const denyFfi = toUniquePathList(input.denyFfi, cwd, home);
    const sysSource = input.sys;
    const sysAll = sysSource === true;
    const sys = sysAll
        ? []
        : normalizeSysApiList(Array.isArray(sysSource) ? sysSource : []);
    const denySys = normalizeSysApiList(input.denySys);
    const wasi = hasOwn(input, "wasi")
        ? input.wasi === true
        : input.node?.allowWasi === true;
    const nodeSettings = {
        allowWorker: workers,
        allowChildProcess: runAll || run.length > 0,
        allowAddons: ffiAll || ffi.length > 0,
        allowWasi: wasi,
    };
    const denoSettings = {
        frozen: input.deno?.frozen !== false,
        allowRun: runAll || run.length > 0,
    };
    return {
        enabled: true,
        mode,
        unsafe: false,
        allowConsole,
        cwd,
        read: resolvedRead,
        readAll,
        write: resolvedWrite,
        writeAll,
        denyRead,
        denyWrite,
        net,
        netAll,
        denyNet,
        allowImport,
        allowImportAll,
        env: {
            allow: envAllow,
            allowAll: envAllowAll,
            deny: envDeny,
            files: envFiles,
        },
        envFiles,
        run,
        runAll,
        denyRun,
        workers,
        ffi,
        ffiAll,
        denyFfi,
        sys,
        sysAll,
        denySys,
        wasi,
        lockFiles: {
            deno: denoLock,
        },
        node: {
            ...nodeSettings,
            flags: toNodeFlags({
                read: resolvedRead,
                readAll,
                write: resolvedWrite,
                writeAll,
                envFiles,
                node: nodeSettings,
            }),
        },
        deno: {
            ...denoSettings,
            flags: toDenoFlags({
                read: resolvedRead,
                readAll,
                write: resolvedWrite,
                writeAll,
                denyRead,
                denyWrite,
                net,
                netAll,
                denyNet,
                allowImport,
                allowImportAll,
                envAllow,
                envAllowAll,
                envDeny,
                envFiles,
                run,
                runAll,
                denyRun,
                ffi,
                ffiAll,
                denyFfi,
                sys,
                sysAll,
                denySys,
                denoLock,
                denoLockEnabled,
                frozen: denoSettings.frozen,
            }),
        },
        l3: cloneL3Keys(),
    };
};
export const toRuntimePermissionFlags = (protocol) => protocol?.enabled === true && protocol.unsafe !== true
    ? (RUNTIME === "node"
        ? protocol.node.flags
        : (RUNTIME === "deno" ? protocol.deno.flags : []))
    : [];
