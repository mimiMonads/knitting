import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RUNTIME } from "../common/runtime.ts";

type PermissionPath = string | URL;

type NodePermissionSettings = {
  allowWorker?: boolean;
  allowChildProcess?: boolean;
  allowAddons?: boolean;
  allowWasi?: boolean;
};

type DenoPermissionSettings = {
  lock?: boolean | PermissionPath;
  frozen?: boolean;
  /**
   * Legacy compatibility: superseded by top-level `run`.
   */
  allowRun?: boolean;
};

type BunPermissionSettings = {
  lock?: boolean | PermissionPath;
  /**
   * Legacy compatibility: superseded by top-level `run`.
   */
  allowRun?: boolean;
};

type StrictPermissionSettings = {
  recursiveScan?: boolean;
  maxEvalDepth?: number;
  sandbox?: boolean;
};

type SysApiName =
  | "hostname"
  | "osRelease"
  | "osUptime"
  | "loadavg"
  | "networkInterfaces"
  | "systemMemoryInfo"
  | "uid"
  | "gid";

type PermissionEnvironment = {
  allow?: string[] | true;
  deny?: string[];
  files?: PermissionPath | PermissionPath[];
};

type PermissionMode = "strict" | "unsafe" | "custom";
type PermissionLegacyMode = "off";

type PermissionProtocol = {
  /**
   * `strict` = hardened defaults, `unsafe` = full access,
   * `custom` = strict baseline with user overrides.
   */
  mode?: PermissionMode;
  /**
   * Console access for worker task code.
   * Defaults to `false` in strict/custom mode, `true` in unsafe mode.
   */
  console?: boolean;
  /**
   * Base directory used to resolve relative paths.
   * Defaults to the current shell working directory.
   */
  cwd?: string;
  /**
   * Read allow-list. `true` means unrestricted access.
   */
  read?: PermissionPath[] | true;
  /**
   * Write allow-list. `true` means unrestricted access.
   */
  write?: PermissionPath[] | true;
  /**
   * Explicit deny-read entries.
   */
  denyRead?: PermissionPath[];
  /**
   * Explicit deny-write entries.
   */
  denyWrite?: PermissionPath[];
  /**
   * Network allow-list. `true` means unrestricted access.
   */
  net?: string[] | true;
  /**
   * Explicit network deny-list.
   */
  denyNet?: string[];
  /**
   * Allowed import hostnames.
   */
  allowImport?: string[];
  /**
   * Environment permission settings.
   */
  env?: PermissionEnvironment;
  /**
   * Subprocess allow-list. `true` means unrestricted access.
   */
  run?: string[] | true;
  /**
   * Explicit subprocess deny-list.
   */
  denyRun?: string[];
  /**
   * Whether worker spawning is allowed.
   */
  workers?: boolean;
  /**
   * FFI allow-list or toggle.
   */
  ffi?: PermissionPath[] | boolean;
  /**
   * Explicit FFI deny-list.
   */
  denyFfi?: PermissionPath[];
  /**
   * System API allow-list. `true` means unrestricted access.
   */
  sys?: SysApiName[] | true;
  /**
   * Explicit system API deny-list.
   */
  denySys?: SysApiName[];
  /**
   * Whether WASI is allowed.
   */
  wasi?: boolean;
  /**
   * Backward-compat runtime overrides.
   */
  node?: NodePermissionSettings;
  deno?: DenoPermissionSettings;
  bun?: BunPermissionSettings;
  strict?: StrictPermissionSettings;
};

type PermissionProtocolInput = PermissionMode | PermissionLegacyMode | PermissionProtocol;

type L3RuntimeKeys = {
  deno: string[];
  node: string[];
  bun: string[];
};

type ResolvedPermissionProtocol = {
  enabled: boolean;
  mode: PermissionMode;
  unsafe: boolean;
  allowConsole: boolean;
  cwd: string;

  read: string[];
  readAll: boolean;
  write: string[];
  writeAll: boolean;
  denyRead: string[];
  denyWrite: string[];

  net: string[];
  netAll: boolean;
  denyNet: string[];
  allowImport: string[];

  env: {
    allow: string[];
    allowAll: boolean;
    deny: string[];
    files: string[];
  };
  // Backward compatibility for existing consumers.
  envFiles: string[];

  run: string[];
  runAll: boolean;
  denyRun: string[];
  workers: boolean;

  ffi: string[];
  ffiAll: boolean;
  denyFfi: string[];

  sys: SysApiName[];
  sysAll: boolean;
  denySys: SysApiName[];

  wasi: boolean;

  lockFiles: {
    deno?: string;
    bun?: string;
  };
  strict: {
    recursiveScan: boolean;
    maxEvalDepth: number;
    sandbox: boolean;
  };
  node: Required<NodePermissionSettings> & { flags: string[] };
  deno: Required<Omit<DenoPermissionSettings, "lock">> & { flags: string[] };
  bun: Required<Omit<BunPermissionSettings, "lock">> & { flags: string[] };
  l3: L3RuntimeKeys;
};

const DEFAULT_ENV_FILE = ".env";
const DEFAULT_DENO_LOCK_FILE = "deno.lock";
const DEFAULT_BUN_LOCK_FILES = ["bun.lockb", "bun.lock"] as const;
const DEFAULT_STRICT_MAX_EVAL_DEPTH = 16;
const MIN_STRICT_MAX_EVAL_DEPTH = 1;
const MAX_STRICT_MAX_EVAL_DEPTH = 64;
const NODE_MODULES_DIR = "node_modules";
const DEFAULT_DENY_RELATIVE = [
  ".env",
  ".git",
  ".npmrc",
  ".docker",
  ".secrets",
] as const;
const DEFAULT_ALLOW_IMPORT_HOSTS = ["deno.land", "esm.sh", "jsr.io"] as const;
const SUPPORTED_SYS_API_NAMES: readonly SysApiName[] = [
  "hostname",
  "osRelease",
  "osUptime",
  "loadavg",
  "networkInterfaces",
  "systemMemoryInfo",
  "uid",
  "gid",
] as const;
const SUPPORTED_SYS_API_NAME_SET = new Set<string>(SUPPORTED_SYS_API_NAMES);

const L3_KEYS: L3RuntimeKeys = {
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
  bun: [
    "read",
    "write",
    "denyRead",
    "denyWrite",
    "net",
    "denyNet",
    "env.allow",
    "env.deny",
    "run",
    "denyRun",
    "ffi",
    "denyFfi",
    "sys",
    "denySys",
    "wasi",
    "workers",
    "allowImport",
  ],
};

const cloneL3Keys = (): L3RuntimeKeys => ({
  deno: [...L3_KEYS.deno],
  node: [...L3_KEYS.node],
  bun: [...L3_KEYS.bun],
});

const DEFAULT_DENY_HOME = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".config/gcloud",
  ".kube",
] as const;
const DEFAULT_DENY_ABSOLUTE_POSIX = [
  "/proc",
  "/proc/self",
  "/proc/self/environ",
  "/proc/self/mem",
  "/sys",
  "/dev",
  "/etc",
] as const;

const clampStrictMaxEvalDepth = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_STRICT_MAX_EVAL_DEPTH;
  const int = Math.floor(value as number);
  if (int < MIN_STRICT_MAX_EVAL_DEPTH) return MIN_STRICT_MAX_EVAL_DEPTH;
  if (int > MAX_STRICT_MAX_EVAL_DEPTH) return MAX_STRICT_MAX_EVAL_DEPTH;
  return int;
};

const resolveStrictPermissionSettings = (
  input: StrictPermissionSettings | undefined,
): {
  recursiveScan: boolean;
  maxEvalDepth: number;
  sandbox: boolean;
} => ({
  recursiveScan: input?.recursiveScan !== false,
  maxEvalDepth: clampStrictMaxEvalDepth(input?.maxEvalDepth),
  sandbox: input?.sandbox === true,
});

const normalizeList = (values: string[]): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
};

const normalizeStringList = (values: readonly string[] | undefined): string[] => {
  if (!values || values.length === 0) return [];
  const cleaned: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    cleaned.push(trimmed);
  }
  return normalizeList(cleaned);
};

const normalizeSysApiList = (values: readonly string[] | undefined): SysApiName[] => {
  if (!values || values.length === 0) return [];
  const out: SysApiName[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (value.length === 0 || seen.has(value)) continue;
    if (!SUPPORTED_SYS_API_NAME_SET.has(value)) continue;
    seen.add(value);
    out.push(value as SysApiName);
  }
  return out;
};

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const normalizeProtocolInput = (
  input: PermissionProtocolInput | undefined,
): PermissionProtocol | undefined =>
  !input ? undefined : (typeof input === "string" ? { mode: input as PermissionMode } : input);

const isWindows = (): boolean => {
  if (typeof process !== "undefined") return process.platform === "win32";
  const g = globalThis as typeof globalThis & {
    Deno?: { build?: { os?: string } };
  };
  return g.Deno?.build?.os === "windows";
};

const getCwd = (): string => {
  try {
    if (typeof process !== "undefined" && typeof process.cwd === "function") {
      return process.cwd();
    }
  } catch {
  }
  const g = globalThis as typeof globalThis & {
    Deno?: { cwd?: () => string };
  };
  try {
    if (typeof g.Deno?.cwd === "function") return g.Deno.cwd();
  } catch {
  }
  return ".";
};

const getHome = (): string | undefined => {
  try {
    if (typeof process !== "undefined" && typeof process.env === "object") {
      const home = process.env.HOME ?? process.env.USERPROFILE;
      if (typeof home === "string" && home.length > 0) return home;
    }
  } catch {
  }

  const g = globalThis as typeof globalThis & {
    Deno?: { env?: { get?: (name: string) => string | undefined } };
  };
  try {
    const home = g.Deno?.env?.get?.("HOME") ?? g.Deno?.env?.get?.("USERPROFILE");
    if (typeof home === "string" && home.length > 0) return home;
  } catch {
  }
  return undefined;
};

const expandHomePath = (value: string, home: string | undefined): string => {
  if (!home) return value;
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(home, value.slice(2));
  }
  return value;
};

const toAbsolutePath = (
  value: PermissionPath,
  cwd: string,
  home: string | undefined,
): string | undefined => {
  if (value instanceof URL) {
    if (value.protocol !== "file:") return undefined;
    return path.resolve(fileURLToPath(value));
  }

  const expanded = expandHomePath(value, home);
  if (path.isAbsolute(expanded)) {
    return path.resolve(expanded);
  }
  try {
    const parsed = new URL(expanded);
    if (parsed.protocol !== "file:") return undefined;
    return path.resolve(fileURLToPath(parsed));
  } catch {
    return path.resolve(cwd, expanded);
  }
};

const toPath = (
  value: PermissionPath | undefined,
  cwd: string,
  home: string | undefined,
): string | undefined =>
  value == null ? undefined : toAbsolutePath(value, cwd, home);

const toPathList = (
  values: PermissionPath[] | undefined,
  cwd: string,
  home: string | undefined,
): string[] => {
  if (!values?.length) return [];
  const out: string[] = [];
  for (const value of values) {
    const resolved = toPath(value, cwd, home);
    if (resolved) out.push(resolved);
  }
  return out;
};

const toUniquePathList = (
  values: PermissionPath[] | undefined,
  cwd: string,
  home: string | undefined,
): string[] => normalizeList(toPathList(values, cwd, home));

const toEnvFiles = (
  input: PermissionPath | PermissionPath[] | undefined,
  cwd: string,
  home: string | undefined,
): string[] => {
  const values = Array.isArray(input) ? input : input ? [input] : [DEFAULT_ENV_FILE];
  return toUniquePathList(values, cwd, home);
};

const isPathWithin = (base: string, candidate: string): boolean => {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const defaultSensitiveProjectAndHomePaths = (
  cwd: string,
  home: string | undefined,
): string[] => {
  const projectSensitive = DEFAULT_DENY_RELATIVE.map((entry) => path.resolve(cwd, entry));
  const homeSensitive = home
    ? DEFAULT_DENY_HOME.map((entry) => path.resolve(home, entry))
    : [];
  return normalizeList([...projectSensitive, ...homeSensitive]);
};

const defaultSensitiveReadDenyPaths = (
  cwd: string,
  home: string | undefined,
): string[] => {
  const projectAndHome = defaultSensitiveProjectAndHomePaths(cwd, home);
  const osSensitive = isWindows()
    ? []
    : DEFAULT_DENY_ABSOLUTE_POSIX.map((entry) => path.resolve(entry));
  return normalizeList([...projectAndHome, ...osSensitive]);
};

const collectWritePaths = (cwd: string, values: string[]): string[] => {
  const out = normalizeList(values.length > 0 ? values : [cwd]);
  if (!out.some((entry) => isPathWithin(entry, cwd) || isPathWithin(cwd, entry))) {
    out.unshift(cwd);
  }
  return normalizeList(out);
};

const collectReadPaths = ({
  cwd,
  read,
  moduleFiles,
  envFiles,
  denoLock,
  bunLock,
}: {
  cwd: string;
  read: string[];
  moduleFiles: string[];
  envFiles: string[];
  denoLock?: string;
  bunLock?: string;
}): string[] => {
  const out = [
    cwd,
    path.resolve(cwd, NODE_MODULES_DIR),
    ...read,
    ...moduleFiles,
    ...envFiles,
  ];
  if (denoLock) out.push(denoLock);
  if (bunLock) out.push(bunLock);
  return normalizeList(out);
};

const resolveBunLock = (
  input: boolean | PermissionPath | undefined,
  cwd: string,
  home: string | undefined,
): string | undefined => {
  if (input === false) return undefined;
  if (input && input !== true) {
    return toPath(input, cwd, home);
  }
  const g = globalThis as typeof globalThis & {
    Deno?: { statSync?: (path: string) => unknown };
    Bun?: {
      file?: (path: string) => { exists?: () => boolean };
    };
  };
  for (const fileName of DEFAULT_BUN_LOCK_FILES) {
    const candidate = path.resolve(cwd, fileName);
    try {
      if (typeof g.Deno?.statSync === "function") {
        g.Deno.statSync(candidate);
        return candidate;
      }
    } catch {
    }
    try {
      if (typeof g.Bun?.file === "function") {
        const file = g.Bun.file(candidate);
        if (typeof file.exists === "function" && file.exists()) return candidate;
      }
    } catch {
    }
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
    }
  }
  return path.resolve(cwd, DEFAULT_BUN_LOCK_FILES[0]);
};

const resolveNodePermissionActivationFlag = (): string => {
  try {
    if (typeof process !== "undefined") {
      const raw = process.versions?.node;
      const major = Number.parseInt(String(raw).split(".", 1)[0] ?? "", 10);
      if (Number.isFinite(major) && major > 0 && major < 22) {
        return "--experimental-permission";
      }
    }
  } catch {
  }
  return "--permission";
};

const toNodeFlags = ({
  read,
  readAll,
  write,
  writeAll,
  envFiles,
  node,
}: {
  read: string[];
  readAll: boolean;
  write: string[];
  writeAll: boolean;
  envFiles: string[];
  node: Required<NodePermissionSettings>;
}): string[] => {
  const modelFlags: string[] = [];

  if (readAll) {
    modelFlags.push("--allow-fs-read=*");
  } else if (read.length > 0) {
    modelFlags.push(`--allow-fs-read=${read.join(",")}`);
  }

  if (writeAll) {
    modelFlags.push("--allow-fs-write=*");
  } else if (write.length > 0) {
    modelFlags.push(`--allow-fs-write=${write.join(",")}`);
  }

  if (node.allowWorker) modelFlags.push("--allow-worker");
  if (node.allowChildProcess) modelFlags.push("--allow-child-process");
  if (node.allowAddons) modelFlags.push("--allow-addons");
  if (node.allowWasi) modelFlags.push("--allow-wasi");

  const flags: string[] = [];
  if (modelFlags.length > 0) {
    flags.push(resolveNodePermissionActivationFlag(), ...modelFlags);
  }

  for (const file of envFiles) {
    flags.push(`--env-file-if-exists=${file}`);
  }

  return flags;
};

const toDenoFlags = ({
  read,
  readAll,
  write,
  writeAll,
  denyRead,
  denyWrite,
  net,
  netAll,
  denyNet,
  allowImport,
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
  frozen,
}: {
  read: string[];
  readAll: boolean;
  write: string[];
  writeAll: boolean;
  denyRead: string[];
  denyWrite: string[];
  net: string[];
  netAll: boolean;
  denyNet: string[];
  allowImport: string[];
  envAllow: string[];
  envAllowAll: boolean;
  envDeny: string[];
  envFiles: string[];
  run: string[];
  runAll: boolean;
  denyRun: string[];
  ffi: string[];
  ffiAll: boolean;
  denyFfi: string[];
  sys: SysApiName[];
  sysAll: boolean;
  denySys: SysApiName[];
  denoLock?: string;
  denoLockEnabled: boolean;
  frozen: boolean;
}): string[] => {
  const flags: string[] = [];

  if (readAll) {
    flags.push("--allow-read");
  } else if (read.length > 0) {
    flags.push(`--allow-read=${read.join(",")}`);
  }

  if (writeAll) {
    flags.push("--allow-write");
  } else if (write.length > 0) {
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
  } else if (net.length > 0) {
    flags.push(`--allow-net=${net.join(",")}`);
  }

  if (denyNet.length > 0) {
    flags.push(`--deny-net=${denyNet.join(",")}`);
  }

  if (allowImport.length > 0) {
    flags.push(`--allow-import=${allowImport.join(",")}`);
  }

  if (envAllowAll) {
    flags.push("--allow-env");
  } else if (envAllow.length > 0) {
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
  } else if (run.length > 0) {
    flags.push(`--allow-run=${run.join(",")}`);
  }

  if (denyRun.length > 0) {
    flags.push(`--deny-run=${denyRun.join(",")}`);
  }

  if (ffiAll) {
    flags.push("--allow-ffi");
  } else if (ffi.length > 0) {
    flags.push(`--allow-ffi=${ffi.join(",")}`);
  }

  if (denyFfi.length > 0) {
    flags.push(`--deny-ffi=${denyFfi.join(",")}`);
  }

  if (sysAll) {
    flags.push("--allow-sys");
  } else if (sys.length > 0) {
    flags.push(`--allow-sys=${sys.join(",")}`);
  }

  if (denySys.length > 0) {
    flags.push(`--deny-sys=${denySys.join(",")}`);
  }

  if (!denoLockEnabled) {
    flags.push("--no-lock");
  } else if (denoLock) {
    flags.push(`--lock=${denoLock}`);
    if (frozen) flags.push("--frozen=true");
  }

  return flags;
};

const toBunFlags = ({
  envFiles,
}: {
  envFiles: string[];
}): string[] => envFiles.map((file) => `--env-file=${file}`);

export const resolvePermissionProtocol = ({
  permission,
  modules,
}: {
  permission?: PermissionProtocolInput;
  modules?: string[];
}): ResolvedPermissionProtocol | undefined => {
  const input = normalizeProtocolInput(permission);
  if (!input) return undefined;

  const rawMode = (input as { mode?: unknown }).mode;
  const mode: PermissionMode = (rawMode === "unsafe" || rawMode === "off")
    ? "unsafe"
    : (rawMode === "custom" ? "custom" : "strict");
  const unsafe = mode === "unsafe";
  const allowConsole = input.console ?? unsafe;
  const strictSettings = resolveStrictPermissionSettings(input.strict);

  const cwd = path.resolve(input.cwd ?? getCwd());
  const home = getHome();

  const envFiles = toEnvFiles(input.env?.files, cwd, home);
  const moduleFiles = toUniquePathList(modules, cwd, home);

  const denoLockInput = input.deno?.lock;
  const denoLockEnabled = denoLockInput !== false;
  const denoLock = denoLockEnabled
    ? (denoLockInput === true || denoLockInput === undefined)
      ? path.resolve(cwd, DEFAULT_DENO_LOCK_FILE)
      : toPath(denoLockInput, cwd, home)
    : undefined;
  const bunLock = resolveBunLock(input.bun?.lock, cwd, home);

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
        bun: bunLock,
      },
      strict: strictSettings,
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
      bun: {
        allowRun: true,
        flags: [],
      },
      l3: cloneL3Keys(),
    };
  }

  const nodeModulesPath = path.resolve(cwd, NODE_MODULES_DIR);
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
      bunLock,
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

  const allowImport = normalizeStringList(
    Array.isArray(input.allowImport) ? input.allowImport : [...DEFAULT_ALLOW_IMPORT_HOSTS],
  );

  const envAllowAll = input.env?.allow === true;
  const envAllow = envAllowAll
    ? []
    : normalizeStringList(Array.isArray(input.env?.allow) ? input.env.allow : []);
  const envDeny = normalizeStringList(input.env?.deny);

  const legacyRunEnabled = input.node?.allowChildProcess === true ||
    input.deno?.allowRun === true ||
    input.bun?.allowRun === true;
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

  const nodeSettings: Required<NodePermissionSettings> = {
    allowWorker: workers,
    allowChildProcess: runAll || run.length > 0,
    allowAddons: ffiAll || ffi.length > 0,
    allowWasi: wasi,
  };
  const denoSettings: Required<Omit<DenoPermissionSettings, "lock">> = {
    frozen: input.deno?.frozen !== false,
    allowRun: runAll || run.length > 0,
  };
  const bunSettings: Required<Omit<BunPermissionSettings, "lock">> = {
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
      bun: bunLock,
    },
    strict: strictSettings,
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
    bun: {
      ...bunSettings,
      flags: toBunFlags({ envFiles }),
    },
    l3: cloneL3Keys(),
  };
};

export const toRuntimePermissionFlags = (
  protocol: ResolvedPermissionProtocol | undefined,
): string[] =>
  protocol?.enabled === true && protocol.unsafe !== true && RUNTIME === "node"
    ? protocol.node.flags
    : [];

export type {
  PermissionPath,
  PermissionMode,
  PermissionLegacyMode,
  SysApiName,
  NodePermissionSettings,
  DenoPermissionSettings,
  BunPermissionSettings,
  StrictPermissionSettings,
  PermissionEnvironment,
  PermissionProtocol,
  PermissionProtocolInput,
  ResolvedPermissionProtocol,
};
