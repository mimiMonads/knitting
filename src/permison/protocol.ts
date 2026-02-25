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
  allowRun?: boolean;
};

type BunPermissionSettings = {
  lock?: boolean | PermissionPath;
  allowRun?: boolean;
};

type StrictPermissionSettings = {
  recursiveScan?: boolean;
  maxEvalDepth?: number;
  sandbox?: boolean;
};

type PermissionEnvironment = {
  files?: PermissionPath | PermissionPath[];
};

type PermisonMode = "strict" | "unsafe";

type PermisonProtocol = {
  /**
   * `strict` = hardened defaults, `unsafe` = full access.
   */
  mode?: PermisonMode;
  /**
   * Console access for worker task code.
   * Defaults to `false` in strict mode, `true` in unsafe mode.
   */
  console?: boolean;
  /**
   * Base directory used to resolve relative paths.
   * Defaults to the current shell working directory.
   */
  cwd?: string;
  /**
   * Extra read allow-list entries.
   */
  read?: PermissionPath[];
  /**
   * Extra write allow-list entries.
   */
  write?: PermissionPath[];
  /**
   * Extra deny-read entries.
   */
  denyRead?: PermissionPath[];
  /**
   * Extra deny-write entries.
   */
  denyWrite?: PermissionPath[];
  env?: PermissionEnvironment;
  node?: NodePermissionSettings;
  deno?: DenoPermissionSettings;
  bun?: BunPermissionSettings;
  strict?: StrictPermissionSettings;
};

type PermisonProtocolInput = PermisonMode | PermisonProtocol;

type ResolvedPermisonProtocol = {
  enabled: boolean;
  mode: PermisonMode;
  unsafe: boolean;
  allowConsole: boolean;
  cwd: string;
  read: string[];
  write: string[];
  denyRead: string[];
  denyWrite: string[];
  envFiles: string[];
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
};

const DEFAULT_ENV_FILE = ".env";
const DEFAULT_DENO_LOCK_FILE = "deno.lock";
const DEFAULT_BUN_LOCK_FILES = ["bun.lockb", "bun.lock"] as const;
const DEFAULT_STRICT_MAX_EVAL_DEPTH = 16;
const MIN_STRICT_MAX_EVAL_DEPTH = 1;
const MAX_STRICT_MAX_EVAL_DEPTH = 64;
const DEFAULT_DENY_RELATIVE = [
  ".env",
  ".git",
  ".npmrc",
  ".docker",
  ".secrets",
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

const normalizeProtocolInput = (
  input: PermisonProtocolInput | undefined,
): PermisonProtocol | undefined =>
  !input ? undefined : (typeof input === "string" ? { mode: input } : input);

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

const toPaths = (
  values: PermissionPath[] | undefined,
  cwd: string,
  home: string | undefined,
): string[] => toPathList(values, cwd, home);

const toEnvFiles = (
  input: PermissionPath | PermissionPath[] | undefined,
  cwd: string,
  home: string | undefined,
): string[] => {
  const values = Array.isArray(input) ? input : input ? [input] : [DEFAULT_ENV_FILE];
  return normalizeList(toPathList(values, cwd, home));
};

const toLockPath = (
  input: boolean | PermissionPath | undefined,
  cwd: string,
  home: string | undefined,
  fallback: string,
): string | undefined => {
  if (input === false) return undefined;
  if (input === true || input === undefined) return path.resolve(cwd, fallback);
  return toPath(input, cwd, home);
};

const toModuleFilePaths = (
  modules: string[] | undefined,
  cwd: string,
  home: string | undefined,
): string[] => {
  return normalizeList(toPathList(modules, cwd, home));
};

const toNodeFlags = ({
  read,
  write,
  envFiles,
  node,
}: {
  read: string[];
  write: string[];
  envFiles: string[];
  node: Required<NodePermissionSettings>;
}): string[] => {
  const flags = [
    "--permission",
    ...read.map((entry) => `--allow-fs-read=${entry}`),
    ...write.map((entry) => `--allow-fs-write=${entry}`),
    ...envFiles.map((file) => `--env-file-if-exists=${file}`),
  ];

  if (node.allowWorker) flags.push("--allow-worker");
  if (node.allowChildProcess) flags.push("--allow-child-process");
  if (node.allowAddons) flags.push("--allow-addons");
  if (node.allowWasi) flags.push("--allow-wasi");

  return flags;
};

const toDenoFlags = ({
  read,
  write,
  denyRead,
  denyWrite,
  envFiles,
  denoLock,
  frozen,
  allowRun,
}: {
  read: string[];
  write: string[];
  denyRead: string[];
  denyWrite: string[];
  envFiles: string[];
  denoLock?: string;
  frozen: boolean;
  allowRun: boolean;
}): string[] => {
  const flags = [
    `--allow-read=${read.join(",")}`,
    `--allow-write=${write.join(",")}`,
    ...envFiles.map((file) => `--env-file=${file}`),
  ];

  if (denyRead.length > 0) {
    flags.push(`--deny-read=${denyRead.join(",")}`);
  }
  if (denyWrite.length > 0) {
    flags.push(`--deny-write=${denyWrite.join(",")}`);
  }
  if (denoLock) {
    flags.push(`--lock=${denoLock}`);
    if (frozen) flags.push("--frozen=true");
  }
  if (allowRun === false) {
    flags.push("--deny-run");
  }

  return flags;
};

const toBunFlags = ({
  envFiles,
  allowRun,
}: {
  envFiles: string[];
  allowRun: boolean;
}): string[] => {
  const flags = envFiles.map((file) => `--env-file=${file}`);
  if (allowRun === false) {
    flags.push("--deny-run");
  }
  return flags;
};

const isPathWithin = (base: string, candidate: string): boolean => {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const defaultSensitiveDenyPaths = (
  cwd: string,
  home: string | undefined,
): string[] => {
  const projectSensitive = DEFAULT_DENY_RELATIVE.map((entry) => path.resolve(cwd, entry));
  const homeSensitive = home
    ? DEFAULT_DENY_HOME.map((entry) => path.resolve(home, entry))
    : [];
  const osSensitive = isWindows()
    ? []
    : DEFAULT_DENY_ABSOLUTE_POSIX.map((entry) => path.resolve(entry));
  return normalizeList([...projectSensitive, ...homeSensitive, ...osSensitive]);
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
    path.resolve(cwd, "node_modules"),
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

export const resolvePermisonProtocol = ({
  permission,
  permison,
  modules,
}: {
  permission?: PermisonProtocolInput;
  permison?: PermisonProtocolInput;
  modules?: string[];
}): ResolvedPermisonProtocol | undefined => {
  const input = normalizeProtocolInput(permission ?? permison);
  if (!input) return undefined;
  const rawMode = (input as { mode?: unknown }).mode;
  const mode = (rawMode === "unsafe" || rawMode === "off")
    ? "unsafe"
    : "strict";
  const unsafe = mode === "unsafe";
  const allowConsole = input.console ?? unsafe;
  const strictSettings = resolveStrictPermissionSettings(input.strict);

  const cwd = path.resolve(input.cwd ?? getCwd());
  const home = getHome();
  if (unsafe) {
    return {
      enabled: true,
      mode,
      unsafe: true,
      allowConsole,
      cwd,
      read: [],
      write: [],
      denyRead: [],
      denyWrite: [],
      envFiles: [],
      lockFiles: {},
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
    };
  }
  const read = toPaths(input.read, cwd, home);
  const write = toPaths(input.write, cwd, home);
  const sensitiveDefaultPaths = defaultSensitiveDenyPaths(cwd, home);
  const denyRead = normalizeList([
    ...toPaths(input.denyRead, cwd, home),
    ...sensitiveDefaultPaths,
  ]);
  const denyWrite = normalizeList([
    ...toPaths(input.denyWrite, cwd, home),
    ...sensitiveDefaultPaths,
    path.resolve(cwd, "node_modules"),
  ]);
  const isDeniedRead = (candidate: string) =>
    denyRead.some((deny) => isPathWithin(deny, candidate));
  const envFiles = toEnvFiles(input.env?.files, cwd, home)
    .filter((entry) => !isDeniedRead(entry));
  const denoLock = toLockPath(
    input.deno?.lock,
    cwd,
    home,
    DEFAULT_DENO_LOCK_FILE,
  );
  const bunLock = resolveBunLock(input.bun?.lock, cwd, home);
  const moduleFiles = toModuleFilePaths(modules, cwd, home);

  const nodeSettings: Required<NodePermissionSettings> = {
    allowWorker: input.node?.allowWorker === true,
    allowChildProcess: input.node?.allowChildProcess === true,
    allowAddons: input.node?.allowAddons === true,
    allowWasi: input.node?.allowWasi === true,
  };
  const denoSettings: Required<Omit<DenoPermissionSettings, "lock">> = {
    frozen: input.deno?.frozen !== false,
    allowRun: input.deno?.allowRun === true,
  };
  const bunSettings: Required<Omit<BunPermissionSettings, "lock">> = {
    allowRun: input.bun?.allowRun === true,
  };

  const resolvedRead = collectReadPaths({
    cwd,
    read,
    moduleFiles,
    envFiles,
    denoLock,
    bunLock,
  });
  const resolvedWrite = collectWritePaths(cwd, write);

  return {
    enabled: true,
    mode,
    unsafe: false,
    allowConsole,
    cwd,
    read: resolvedRead,
    write: resolvedWrite,
    denyRead,
    denyWrite,
    envFiles,
    lockFiles: {
      deno: denoLock,
      bun: bunLock,
    },
    strict: strictSettings,
    node: {
      ...nodeSettings,
      flags: toNodeFlags({
        read: resolvedRead,
        write: resolvedWrite,
        envFiles,
        node: nodeSettings,
      }),
    },
    deno: {
      ...denoSettings,
      flags: toDenoFlags({
        read: resolvedRead,
        write: resolvedWrite,
        denyRead,
        denyWrite,
        envFiles,
        denoLock,
        frozen: denoSettings.frozen,
        allowRun: denoSettings.allowRun,
      }),
    },
    bun: {
      ...bunSettings,
      flags: toBunFlags({
        envFiles,
        allowRun: bunSettings.allowRun,
      }),
    },
  };
};

export const toRuntimePermissionFlags = (
  protocol: ResolvedPermisonProtocol | undefined,
): string[] => {
  return protocol?.enabled === true && protocol.unsafe !== true && RUNTIME === "node"
    ? protocol.node.flags
    : [];
};

export type {
  PermissionPath as PermissionPath,
  PermisonMode as PermisonMode,
  NodePermissionSettings as NodePermissionSettings,
  DenoPermissionSettings as DenoPermissionSettings,
  BunPermissionSettings as BunPermissionSettings,
  StrictPermissionSettings as StrictPermissionSettings,
  PermissionEnvironment as PermissionEnvironment,
  PermisonProtocol as PermisonProtocol,
  PermisonProtocolInput as PermisonProtocolInput,
  ResolvedPermisonProtocol as ResolvedPermisonProtocol,
};
