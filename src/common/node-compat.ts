export type NodeProcessLike = {
  getBuiltinModule?: (id: string) => unknown;
  versions?: {
    node?: string;
  };
  platform?: string;
  allowedNodeEnvironmentFlags?: ReadonlySet<string>;
  execArgv?: string[];
  cwd?: () => string;
  env?: Record<string, string | undefined>;
  on?: (event: string, handler: (...args: unknown[]) => void) => unknown;
};

export type NodeCallSiteLike = {
  getFileName?: () => string | null | undefined;
  getFunctionName?: () => string | null | undefined;
  getMethodName?: () => string | null | undefined;
};

const nodeProcess = (() => {
  const candidate = (globalThis as typeof globalThis & { process?: unknown })
    .process as NodeProcessLike | undefined;
  return typeof candidate?.versions?.node === "string" ? candidate : undefined;
})();

export const getNodeProcess = (): NodeProcessLike | undefined => nodeProcess;

export const getNodeBuiltinModule = <T>(
  specifier: string,
): T | undefined => {
  const getter = nodeProcess?.getBuiltinModule;
  if (typeof getter !== "function") return undefined;

  try {
    return getter.call(nodeProcess, specifier) as T | undefined;
  } catch {
  }

  if (!specifier.startsWith("node:")) return undefined;

  try {
    return getter.call(nodeProcess, specifier.slice(5)) as T | undefined;
  } catch {
    return undefined;
  }
};

type PathModuleLike = {
  resolve: (...segments: string[]) => string;
  join: (...segments: string[]) => string;
  dirname: (value: string) => string;
  basename: (value: string) => string;
  relative: (from: string, to: string) => string;
  isAbsolute: (value: string) => boolean;
};

type FsModuleLike = {
  existsSync?: (candidate: string) => boolean;
  realpathSync?: ((candidate: string) => string) & {
    native?: (candidate: string) => string;
  };
};

type UrlModuleLike = {
  fileURLToPath?: (value: string | URL) => string;
  pathToFileURL?: (value: string) => URL;
};

const rawPathModule = getNodeBuiltinModule<
  PathModuleLike & { default?: PathModuleLike }
>("node:path");
const rawFsModule = getNodeBuiltinModule<FsModuleLike>("node:fs");
const rawUrlModule = getNodeBuiltinModule<UrlModuleLike>("node:url");

const pathModule = (rawPathModule?.default ?? rawPathModule) as
  | PathModuleLike
  | undefined;

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[/\\]/;
const WINDOWS_UNC_PATH = /^[/\\]{2}[^/\\]+[/\\][^/\\]+/;

const hostIsWindows = (() => {
  try {
    if (typeof nodeProcess?.platform === "string") {
      return nodeProcess.platform === "win32";
    }
  } catch {
  }
  const g = globalThis as typeof globalThis & {
    Deno?: { build?: { os?: string } };
  };
  return g.Deno?.build?.os === "windows";
})();

const looksWindowsPath = (value: string) =>
  hostIsWindows || WINDOWS_DRIVE_PATH.test(value) || WINDOWS_UNC_PATH.test(value);

const normalizePathSeparators = (value: string) => value.replace(/\\/g, "/");

const splitRoot = (value: string): { root: string; rest: string } => {
  const normalized = normalizePathSeparators(value);
  if (WINDOWS_UNC_PATH.test(value)) {
    const [, host = "", share = "", rest = ""] = normalized.match(
      /^\/\/([^/]+)\/([^/]+)(\/.*)?$/,
    ) ?? [];
    return {
      root: `//${host}/${share}`,
      rest: rest.replace(/^\/+/, ""),
    };
  }
  if (WINDOWS_DRIVE_PATH.test(value)) {
    return {
      root: normalized.slice(0, 2).toUpperCase() + "/",
      rest: normalized.slice(3),
    };
  }
  if (normalized.startsWith("/")) {
    return {
      root: "/",
      rest: normalized.replace(/^\/+/, ""),
    };
  }
  return {
    root: "",
    rest: normalized,
  };
};

const normalizeJoinedPath = (value: string): string => {
  const { root, rest } = splitRoot(value);
  const parts = rest.split("/");
  const stack: string[] = [];

  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else if (!root) {
        stack.push("..");
      }
      continue;
    }
    stack.push(part);
  }

  if (root) {
    const joined = stack.join("/");
    return joined.length > 0 ? `${root}${joined}` : root;
  }
  return stack.length > 0 ? stack.join("/") : ".";
};

const fallbackIsAbsolute = (value: string): boolean => {
  if (value.length === 0) return false;
  const normalized = normalizePathSeparators(value);
  return normalized.startsWith("/") ||
    WINDOWS_DRIVE_PATH.test(value) ||
    WINDOWS_UNC_PATH.test(value);
};

const fallbackResolve = (...segments: string[]): string => {
  let resolved = "";
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (!segment) continue;
    resolved = resolved ? `${segment}/${resolved}` : segment;
    if (fallbackIsAbsolute(segment)) break;
  }
  if (!fallbackIsAbsolute(resolved)) {
    resolved = `/${resolved}`;
  }
  return normalizeJoinedPath(resolved);
};

const fallbackJoin = (...segments: string[]): string =>
  normalizeJoinedPath(segments.filter(Boolean).join("/"));

const fallbackDirname = (value: string): string => {
  const normalized = normalizeJoinedPath(value);
  const { root, rest } = splitRoot(normalized);
  if (!rest) return root || ".";
  const parts = rest.split("/");
  parts.pop();
  if (root) {
    return parts.length > 0 ? `${root}${parts.join("/")}` : root;
  }
  return parts.length > 0 ? parts.join("/") : ".";
};

const fallbackBasename = (value: string): string => {
  const normalized = normalizeJoinedPath(value);
  const { rest } = splitRoot(normalized);
  const parts = rest.split("/");
  return parts[parts.length - 1] ?? "";
};

const splitRelativeParts = (value: string): string[] => {
  const normalized = normalizeJoinedPath(value);
  const { rest } = splitRoot(normalized);
  if (!rest) return [];
  return rest.split("/").filter(Boolean);
};

const fallbackRelative = (from: string, to: string): string => {
  const fromResolved = fallbackResolve(from);
  const toResolved = fallbackResolve(to);
  const fromRoot = splitRoot(fromResolved).root;
  const toRoot = splitRoot(toResolved).root;
  if (fromRoot !== toRoot) return toResolved;

  const fromParts = splitRelativeParts(fromResolved);
  const toParts = splitRelativeParts(toResolved);

  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }

  const up = new Array(fromParts.length - common).fill("..");
  const down = toParts.slice(common);
  const out = [...up, ...down].join("/");
  return out.length > 0 ? out : "";
};

const encodeFilePath = (value: string) =>
  encodeURI(value)
    .replace(/\?/g, "%3F")
    .replace(/#/g, "%23");

const fallbackFileURLToPath = (value: string | URL): string => {
  const url = value instanceof URL ? value : new URL(value);
  if (url.protocol !== "file:") {
    throw new TypeError("Expected a file URL");
  }
  let pathname = decodeURIComponent(url.pathname);
  if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1);
  if (url.host.length > 0) {
    return `//${url.host}${pathname}`;
  }
  return looksWindowsPath(pathname) ? pathname.replace(/\//g, "\\") : pathname;
};

const fallbackPathToFileURL = (value: string): URL => {
  if (WINDOWS_UNC_PATH.test(value)) {
    const normalized = normalizePathSeparators(value).replace(/^\/+/, "");
    return new URL(`file://${encodeFilePath(normalized)}`);
  }
  if (WINDOWS_DRIVE_PATH.test(value)) {
    const normalized = normalizePathSeparators(value);
    return new URL(`file:///${encodeFilePath(normalized)}`);
  }
  const absolute = fallbackIsAbsolute(value) ? value : fallbackResolve(value);
  const normalized = normalizePathSeparators(absolute);
  return new URL(`file://${encodeFilePath(normalized.startsWith("/") ? normalized : `/${normalized}`)}`);
};

export const pathResolve = pathModule?.resolve
  ? ((...args: Parameters<NonNullable<typeof pathModule.resolve>>) =>
    pathModule.resolve!(...args))
  : fallbackResolve;
export const pathJoin = pathModule?.join
  ? ((...args: Parameters<NonNullable<typeof pathModule.join>>) =>
    pathModule.join!(...args))
  : fallbackJoin;
export const pathDirname = pathModule?.dirname
  ? ((...args: Parameters<NonNullable<typeof pathModule.dirname>>) =>
    pathModule.dirname!(...args))
  : fallbackDirname;
export const pathBasename = pathModule?.basename
  ? ((...args: Parameters<NonNullable<typeof pathModule.basename>>) =>
    pathModule.basename!(...args))
  : fallbackBasename;
export const pathRelative = pathModule?.relative
  ? ((...args: Parameters<NonNullable<typeof pathModule.relative>>) =>
    pathModule.relative!(...args))
  : fallbackRelative;
export const pathIsAbsolute = pathModule?.isAbsolute
  ? ((...args: Parameters<NonNullable<typeof pathModule.isAbsolute>>) =>
    pathModule.isAbsolute!(...args))
  : fallbackIsAbsolute;

export const fileURLToPathCompat = rawUrlModule?.fileURLToPath ??
  fallbackFileURLToPath;
export const pathToFileURLCompat = rawUrlModule?.pathToFileURL ??
  fallbackPathToFileURL;

export const existsSyncCompat = rawFsModule?.existsSync;
export const realpathSyncCompat = rawFsModule?.realpathSync?.native ??
  rawFsModule?.realpathSync;
