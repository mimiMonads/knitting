import path from "node:path";
import { createRequire } from "node:module";
import type { ResolvedPermissionProtocol } from "../../permission/protocol.ts";
import { fileURLToPath } from "node:url";

type GlobalWithPermissionGuard = typeof globalThis & {
  __knittingPermissionGuardInstalled?: boolean;
  __knittingConsoleGuardInstalled?: boolean;
  __knittingWorkerSpawnGuardInstalled?: boolean;
  Deno?: Record<string, unknown>;
  Bun?: Record<string, unknown>;
  console?: Record<string, unknown>;
  Worker?: unknown;
};

const WRAPPED = Symbol.for("knitting.permission.wrapped");
const require = createRequire(import.meta.url);
const fsApi = (() => {
  try {
    return require("node:fs") as {
      existsSync?: (path: string) => boolean;
      realpathSync?: ((path: string) => string) & {
        native?: (path: string) => string;
      };
    };
  } catch {
    return undefined;
  }
})();
const rawExistsSync = typeof fsApi?.existsSync === "function"
  ? fsApi.existsSync
  : undefined;
const rawRealpathSync = (() => {
  const maybe = fsApi?.realpathSync?.native ?? fsApi?.realpathSync;
  return typeof maybe === "function"
    ? (maybe as (path: string) => string)
    : undefined;
})();
const maybeSyncBuiltinESMExports = (() => {
  try {
    const moduleApi = require("node:module") as {
      syncBuiltinESMExports?: () => void;
    };
    return moduleApi.syncBuiltinESMExports;
  } catch {
    return undefined;
  }
})();

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isOptionalModuleLoadError = (error: unknown): boolean => {
  const code = typeof error === "object" && error !== null &&
      "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  if (code === "MODULE_NOT_FOUND" || code === "ERR_UNKNOWN_BUILTIN_MODULE") {
    return true;
  }
  const message = toErrorMessage(error);
  return message.includes("Cannot find module") ||
    message.includes("No such built-in module") ||
    message.includes("Dynamic require of") ||
    message.includes("is not supported");
};

const loadOptionalBuiltin = (id: string): Record<string, unknown> | undefined => {
  try {
    return require(id) as Record<string, unknown>;
  } catch (error) {
    if (isOptionalModuleLoadError(error)) return undefined;
    throw new Error(
      `KNT_ERROR_PERMISSION_GUARD_INSTALL: failed to load ${id}: ${toErrorMessage(error)}`,
    );
  }
};

const failGuardInstall = (
  target: string,
  reason: string,
  cause?: unknown,
): never => {
  const suffix = cause === undefined ? "" : `: ${toErrorMessage(cause)}`;
  throw new Error(
    `KNT_ERROR_PERMISSION_GUARD_INSTALL: ${target} ${reason}${suffix}`,
  );
};

const isPathWithin = (base: string, candidate: string): boolean => {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const toCanonicalPath = (candidate: string): string => {
  const absolute = path.resolve(candidate);
  const realpath = rawRealpathSync;
  const direct = (() => {
    if (!realpath) return undefined;
    try {
      return realpath(absolute);
    } catch {
      return undefined;
    }
  })();
  if (direct) return path.resolve(direct);
  if (!rawExistsSync || !realpath) return absolute;

  const missingSegments: string[] = [];
  let cursor = absolute;
  while (!rawExistsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return absolute;
    missingSegments.push(path.basename(cursor));
    cursor = parent;
  }

  let base = cursor;
  try {
    base = realpath(cursor);
  } catch {
  }

  let rebuilt = base;
  for (let i = missingSegments.length - 1; i >= 0; i--) {
    rebuilt = path.join(rebuilt, missingSegments[i]!);
  }
  return path.resolve(rebuilt);
};

const toStringPath = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (value instanceof URL) {
    if (value.protocol === "file:") return fileURLToPath(value);
    return undefined;
  }
  return undefined;
};

const toAbsolutePath = (value: unknown, cwd: string): string | undefined => {
  const raw = toStringPath(value);
  if (!raw) return undefined;
  if (path.isAbsolute(raw)) {
    return path.resolve(raw);
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "file:") return undefined;
    return path.resolve(fileURLToPath(parsed));
  } catch {
    return path.resolve(cwd, raw);
  }
};

const shouldDenyPath = (
  value: unknown,
  cwd: string,
  denied: string[],
): boolean => {
  const absolute = toAbsolutePath(value, cwd);
  if (!absolute) return false;
  const resolved = toCanonicalPath(absolute);
  return denied.some((deny) => isPathWithin(deny, resolved));
};

const isNodeOpenForWrite = (flag: unknown): boolean => {
  if (typeof flag === "string") return /[wa+]/.test(flag);
  if (typeof flag === "number") return true;
  if (
    typeof flag === "object" &&
    flag !== null &&
    "flags" in flag
  ) {
    return isNodeOpenForWrite((flag as { flags?: unknown }).flags);
  }
  return false;
};

const isNodeOpenForRead = (flag: unknown): boolean => {
  if (typeof flag === "string") return /r/.test(flag);
  if (typeof flag === "number") return true;
  if (
    typeof flag === "object" &&
    flag !== null &&
    "flags" in flag
  ) {
    return isNodeOpenForRead((flag as { flags?: unknown }).flags);
  }
  return true;
};

const isDenoOpenForWrite = (options: unknown): boolean => {
  if (!options || typeof options !== "object") return false;
  const o = options as {
    write?: boolean;
    append?: boolean;
    create?: boolean;
    truncate?: boolean;
  };
  return o.write === true || o.append === true || o.create === true ||
    o.truncate === true;
};

const throwDeniedAccess = (
  target: unknown,
  mode: "read" | "write" | "run",
): never => {
  throw new Error(
    `KNT_ERROR_PERMISSION_DENIED: ${mode} access denied for ${String(target)}`,
  );
};

type DeniedAccess = { target: unknown; mode: "read" | "write" | "run" };

const safeWrap = (
  target: Record<string, unknown>,
  method: string,
  check: (args: unknown[]) => DeniedAccess | undefined,
) => {
  const original = target[method];
  if (typeof original !== "function") return;
  if ((original as unknown as { [WRAPPED]?: boolean })[WRAPPED] === true) {
    return;
  }

  const wrapped = function (this: unknown, ...args: unknown[]) {
    const denied = check(args);
    if (denied) {
      return throwDeniedAccess(denied.target, denied.mode);
    }
    return Reflect.apply(
      original as (...args: unknown[]) => unknown,
      this,
      args,
    );
  };

  (wrapped as unknown as { [WRAPPED]?: boolean })[WRAPPED] = true;
  try {
    target[method] = wrapped;
  } catch (error) {
    failGuardInstall(method, "wrap assignment failed", error);
  }

  const installed = target[method];
  if (
    typeof installed !== "function" ||
    (installed as unknown as { [WRAPPED]?: boolean })[WRAPPED] !== true
  ) {
    failGuardInstall(method, "wrap verification failed");
  }
};

const wrapMethods = (
  target: Record<string, unknown>,
  methods: readonly string[],
  check: (args: unknown[]) => DeniedAccess | undefined,
) => {
  for (const method of methods) safeWrap(target, method, check);
};

const wrapMethodsAndSync = (
  target: Record<string, unknown>,
  methods: readonly string[],
  check: (args: unknown[]) => DeniedAccess | undefined,
) => {
  for (const method of methods) {
    safeWrap(target, method, check);
    safeWrap(target, `${method}Sync`, check);
  }
};

const createAccessChecks = ({
  cwd,
  denyRead,
  denyWrite,
}: {
  cwd: string;
  denyRead: string[];
  denyWrite: string[];
}) => {
  const canonicalDenyRead = denyRead.map((entry) => toCanonicalPath(entry));
  const canonicalDenyWrite = denyWrite.map((entry) => toCanonicalPath(entry));
  const readAt = (index: number) => (args: unknown[]): DeniedAccess | undefined =>
    shouldDenyPath(args[index], cwd, canonicalDenyRead)
      ? { target: args[index], mode: "read" }
      : undefined;
  const writeAt = (index: number) => (args: unknown[]): DeniedAccess | undefined =>
    shouldDenyPath(args[index], cwd, canonicalDenyWrite)
      ? { target: args[index], mode: "write" }
      : undefined;
  const readWriteAt = (
    readIndex: number,
    writeIndex: number,
  ) =>
  (args: unknown[]): DeniedAccess | undefined =>
    readAt(readIndex)(args) ?? writeAt(writeIndex)(args);
  const nodeOpen = (args: unknown[]): DeniedAccess | undefined => {
    if (isNodeOpenForWrite(args[1])) return writeAt(0)(args);
    if (isNodeOpenForRead(args[1])) return readAt(0)(args);
    return undefined;
  };
  const denoOpen = (args: unknown[]): DeniedAccess | undefined =>
    isDenoOpenForWrite(args[1]) ? writeAt(0)(args) : readAt(0)(args);

  return {
    readAt,
    writeAt,
    readWriteAt,
    nodeOpen,
    denoOpen,
  };
};

type NetworkPolicy = {
  netAll: boolean;
  allow: readonly string[];
  deny: readonly string[];
};

type NetworkEndpoint = {
  host?: string;
  port?: string;
  label: string;
};

type NetworkRule = {
  any: boolean;
  host?: string;
  port?: string;
};

const DEFAULT_NET_HOST = "localhost";

const normalizeNetHost = (value: string): string =>
  value.trim().replace(/^\[|\]$/g, "").toLowerCase();

const toPortString = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return String(Math.floor(value));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return trimmed;
  }
  return undefined;
};

const defaultPortForProtocol = (protocol: string): string | undefined => {
  const cleaned = protocol.replace(/:$/, "").toLowerCase();
  if (cleaned === "http" || cleaned === "ws") return "80";
  if (cleaned === "https" || cleaned === "wss") return "443";
  return undefined;
};

const toEndpointFromURL = (
  value: string | URL,
  fallback: string,
): NetworkEndpoint | undefined => {
  try {
    const parsed = typeof value === "string" ? new URL(value) : value;
    const host = parsed.hostname ? normalizeNetHost(parsed.hostname) : undefined;
    const port = parsed.port.length > 0 ? parsed.port : defaultPortForProtocol(parsed.protocol);
    const label = parsed.toString();
    if (!host) return { label };
    return { host, port, label };
  } catch {
    return undefined;
  }
};

const toEndpointFromHostPortString = (
  value: string,
  fallback: string,
): NetworkEndpoint => {
  const runningOnWindows = typeof process !== "undefined" && process.platform === "win32";
  const trimmed = value.trim();
  if (trimmed.length === 0) return { label: fallback };
  if (!trimmed.includes("://")) {
    const startsWithBracket = trimmed.startsWith("[");
    if (startsWithBracket) {
      const closeIndex = trimmed.indexOf("]");
      if (closeIndex > 1) {
        const host = normalizeNetHost(trimmed.slice(1, closeIndex));
        const remainder = trimmed.slice(closeIndex + 1);
        if (remainder.startsWith(":")) {
          const port = toPortString(remainder.slice(1));
          return {
            host,
            port,
            label: port ? `${host}:${port}` : host,
          };
        }
        return { host, label: host };
      }
    }

    const lastColon = trimmed.lastIndexOf(":");
    const hasOneColon = lastColon > 0 && trimmed.indexOf(":") === lastColon;
    if (hasOneColon) {
      const hostToken = trimmed.slice(0, lastColon);
      const portToken = trimmed.slice(lastColon + 1);
      if (portToken.length > 0 && /^\d+$/.test(portToken)) {
        const host = normalizeNetHost(hostToken);
        return { host, port: portToken, label: `${host}:${portToken}` };
      }
    }

    if (
      trimmed.includes(path.sep) ||
      (runningOnWindows && trimmed.includes("\\")) ||
      trimmed.startsWith(".") ||
      trimmed.startsWith("/")
    ) {
      return { label: trimmed };
    }
    const host = normalizeNetHost(trimmed);
    return { host, label: host };
  }
  const fromUrl = toEndpointFromURL(trimmed, fallback);
  return fromUrl ?? { label: trimmed };
};

const toEndpointFromUnknown = (
  value: unknown,
  fallback: string,
): NetworkEndpoint => {
  if (typeof value === "string") {
    return toEndpointFromHostPortString(value, fallback);
  }
  if (value instanceof URL) {
    return toEndpointFromURL(value, fallback) ?? { label: fallback };
  }
  if (typeof value === "object" && value !== null) {
    if ("url" in value && typeof (value as { url?: unknown }).url === "string") {
      const byUrl = toEndpointFromURL((value as { url: string }).url, fallback);
      if (byUrl) return byUrl;
    }
    const host = typeof (value as { hostname?: unknown }).hostname === "string"
      ? (value as { hostname: string }).hostname
      : (typeof (value as { host?: unknown }).host === "string"
        ? (value as { host: string }).host
        : undefined);
    const port = toPortString((value as { port?: unknown }).port);
    if (typeof host === "string" && host.trim().length > 0) {
      const normalized = normalizeNetHost(host);
      return {
        host: normalized,
        port,
        label: port ? `${normalized}:${port}` : normalized,
      };
    }
    const socketPath = typeof (value as { socketPath?: unknown }).socketPath === "string"
      ? (value as { socketPath: string }).socketPath
      : (typeof (value as { path?: unknown }).path === "string"
        ? (value as { path: string }).path
        : undefined);
    if (typeof socketPath === "string" && socketPath.length > 0) {
      return { label: socketPath };
    }
  }
  return { label: fallback };
};

const toNetworkRule = (raw: string): NetworkRule | undefined => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed === "*") return { any: true };
  const asUrl = trimmed.includes("://")
    ? toEndpointFromURL(trimmed, trimmed)
    : undefined;
  if (asUrl?.host) {
    return {
      any: false,
      host: asUrl.host,
      port: asUrl.port,
    };
  }
  const hostPort = toEndpointFromHostPortString(trimmed, trimmed);
  if (!hostPort.host) return undefined;
  return {
    any: false,
    host: hostPort.host,
    port: hostPort.port,
  };
};

const matchesNetRule = (
  endpoint: NetworkEndpoint,
  rule: NetworkRule,
): boolean => {
  if (rule.any) return true;
  if (!rule.host || !endpoint.host) return false;
  if (rule.host !== endpoint.host) return false;
  if (rule.port && endpoint.port !== rule.port) return false;
  return true;
};

const createNetworkAccessEvaluator = (policy: NetworkPolicy) => {
  const allowRules = policy.allow
    .map((entry) => toNetworkRule(entry))
    .filter((entry): entry is NetworkRule => Boolean(entry));
  const denyRules = policy.deny
    .map((entry) => toNetworkRule(entry))
    .filter((entry): entry is NetworkRule => Boolean(entry));

  return (endpoint: NetworkEndpoint): boolean => {
    if (denyRules.some((rule) => matchesNetRule(endpoint, rule))) {
      return false;
    }

    if (policy.netAll) {
      if (denyRules.length > 0 && !endpoint.host) return false;
      return true;
    }

    if (!endpoint.host) return false;
    if (allowRules.length === 0) return false;
    return allowRules.some((rule) => matchesNetRule(endpoint, rule));
  };
};

const createNetworkCheck = ({
  policy,
  fallback,
  resolveEndpoint,
}: {
  policy: NetworkPolicy;
  fallback: string;
  resolveEndpoint: (args: unknown[]) => NetworkEndpoint;
}) => {
  const canAccessNetwork = createNetworkAccessEvaluator(policy);
  return (args: unknown[]): DeniedAccess | undefined => {
    const endpoint = resolveEndpoint(args);
    if (canAccessNetwork(endpoint)) return undefined;
    return {
      target: endpoint.label || fallback,
      mode: "run",
    };
  };
};

const mergeEndpointWithOptions = (
  base: NetworkEndpoint,
  options: unknown,
): NetworkEndpoint => {
  if (!options || typeof options !== "object") return base;
  const hostFromOptions = typeof (options as { hostname?: unknown }).hostname === "string"
    ? (options as { hostname: string }).hostname
    : (typeof (options as { host?: unknown }).host === "string"
      ? (options as { host: string }).host
      : undefined);
  const portFromOptions = toPortString((options as { port?: unknown }).port);
  if (typeof hostFromOptions !== "string" || hostFromOptions.trim().length === 0) {
    return base;
  }
  const host = normalizeNetHost(hostFromOptions);
  return {
    host,
    port: portFromOptions ?? base.port,
    label: portFromOptions ? `${host}:${portFromOptions}` : host,
  };
};

const resolveFetchEndpoint = (args: unknown[]): NetworkEndpoint =>
  toEndpointFromUnknown(args[0], "fetch");

const resolveNodeNetEndpoint = (args: unknown[]): NetworkEndpoint => {
  const first = args[0];
  const second = args[1];
  if (typeof first === "number") {
    const port = toPortString(first);
    const host = typeof second === "string" && second.trim().length > 0
      ? normalizeNetHost(second)
      : DEFAULT_NET_HOST;
    return {
      host,
      port,
      label: port ? `${host}:${port}` : host,
    };
  }
  if (typeof first === "string" && /^\d+$/.test(first.trim())) {
    const port = first.trim();
    const host = typeof second === "string" && second.trim().length > 0
      ? normalizeNetHost(second)
      : DEFAULT_NET_HOST;
    return { host, port, label: `${host}:${port}` };
  }
  return toEndpointFromUnknown(first, "node:net");
};

const resolveNodeHttpEndpoint = (args: unknown[]): NetworkEndpoint => {
  const first = args[0];
  const second = args[1];
  const base = toEndpointFromUnknown(first, "node:http");
  return mergeEndpointWithOptions(base, second);
};

const resolveDenoConnectEndpoint = (args: unknown[]): NetworkEndpoint =>
  toEndpointFromUnknown(args[0], "Deno.connect");

const resolveBunServeEndpoint = (args: unknown[]): NetworkEndpoint =>
  toEndpointFromUnknown(args[0], "Bun.serve");

const installNodeEnvGuard = ({
  allowAll,
  allow,
  deny,
}: {
  allowAll: boolean;
  allow: readonly string[];
  deny: readonly string[];
}): void => {
  if (typeof process === "undefined") return;

  const proc = process as NodeJS.Process & {
    __knittingEnvGuardInstalled?: boolean;
  };
  if (proc.__knittingEnvGuardInstalled === true) return;

  const env = proc.env as Record<PropertyKey, unknown>;
  if (!env || typeof env !== "object") {
    proc.__knittingEnvGuardInstalled = true;
    return;
  }

  const envKeyCaseInsensitive = proc.platform === "win32";
  const normalizeEnvKey = (key: string): string =>
    envKeyCaseInsensitive ? key.toUpperCase() : key;
  const allowSet = new Set(allow.map((key) => normalizeEnvKey(key)));
  const denySet = new Set(deny.map((key) => normalizeEnvKey(key)));
  const isRestricted = allowAll !== true || denySet.size > 0;
  if (!isRestricted) {
    proc.__knittingEnvGuardInstalled = true;
    return;
  }

  const isEnvAccessAllowed = (key: string): boolean => {
    const normalized = normalizeEnvKey(key);
    if (denySet.has(normalized)) return false;
    if (allowAll) return true;
    return allowSet.has(normalized);
  };
  const isPrototypeKey = (key: string): boolean =>
    key in Object.prototype || key === "__proto__";

  const guardedEnv = new Proxy(env, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") {
        return Reflect.get(target, prop, receiver);
      }
      if (isPrototypeKey(prop)) {
        return Reflect.get(target, prop, receiver);
      }
      if (!isEnvAccessAllowed(prop)) {
        return undefined;
      }
      return Reflect.get(target, prop, receiver);
    },
    set: (target, prop, value, receiver) => Reflect.set(target, prop, value, receiver),
    deleteProperty: (target, prop) => Reflect.deleteProperty(target, prop),
    has(target, prop) {
      if (typeof prop === "string" && !isPrototypeKey(prop) && !isEnvAccessAllowed(prop)) {
        return false;
      }
      return Reflect.has(target, prop);
    },
    ownKeys(target) {
      const keys = Reflect.ownKeys(target);
      return keys.filter((key) => typeof key !== "string" || isEnvAccessAllowed(key));
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === "string" && !isPrototypeKey(prop) && !isEnvAccessAllowed(prop)) {
        return undefined;
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    defineProperty: (target, prop, descriptor) =>
      Reflect.defineProperty(target, prop, descriptor),
  });

  try {
    Object.defineProperty(proc, "env", {
      configurable: false,
      writable: false,
      value: guardedEnv,
    });
  } catch (defineError) {
    try {
      (proc as unknown as { env: unknown }).env = guardedEnv;
    } catch (assignError) {
      failGuardInstall("process.env", "install failed", [
        toErrorMessage(defineError),
        toErrorMessage(assignError),
      ].join("; "));
    }
  }

  if (proc.env !== guardedEnv) {
    failGuardInstall("process.env", "install verification failed");
  }
  proc.__knittingEnvGuardInstalled = true;
};

const installGlobalFetchGuard = (policy: NetworkPolicy): void => {
  const g = globalThis as GlobalWithPermissionGuard & {
    fetch?: unknown;
  };
  if (typeof g.fetch !== "function") return;
  safeWrap(
    g as unknown as Record<string, unknown>,
    "fetch",
    createNetworkCheck({
      policy,
      fallback: "fetch",
      resolveEndpoint: resolveFetchEndpoint,
    }),
  );
};

const installNodeNetworkGuard = (policy: NetworkPolicy): void => {
  installGlobalFetchGuard(policy);

  let wrappedAny = false;
  for (const moduleId of ["node:net", "net"] as const) {
    const netModule = loadOptionalBuiltin(moduleId);
    if (!netModule) continue;
    wrapMethods(
      netModule,
      ["connect", "createConnection", "createServer"],
      createNetworkCheck({
        policy,
        fallback: moduleId,
        resolveEndpoint: resolveNodeNetEndpoint,
      }),
    );
    wrappedAny = true;
  }

  for (const moduleId of ["node:http", "http", "node:https", "https"] as const) {
    const httpModule = loadOptionalBuiltin(moduleId);
    if (!httpModule) continue;
    wrapMethods(
      httpModule,
      ["request", "get", "createServer"],
      createNetworkCheck({
        policy,
        fallback: moduleId,
        resolveEndpoint: resolveNodeHttpEndpoint,
      }),
    );
    wrappedAny = true;
  }

  if (wrappedAny) {
    maybeSyncBuiltinESMExports?.();
  }
};

const installConsoleGuard = (): void => {
  const g = globalThis as GlobalWithPermissionGuard;
  if (g.__knittingConsoleGuardInstalled === true) return;
  g.__knittingConsoleGuardInstalled = true;
  if (!g.console || typeof g.console !== "object") return;

  const noop = () => {};
  for (const method of [
    "log",
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "dir",
    "dirxml",
    "table",
  ]) {
    try {
      Object.defineProperty(g.console, method, {
        configurable: false,
        writable: false,
        value: noop,
      });
    } catch {
      try {
        g.console[method] = noop;
      } catch {
      }
    }
  }
};

const installNodeFsGuard = ({
  cwd,
  denyRead,
  denyWrite,
}: {
  cwd: string;
  denyRead: string[];
  denyWrite: string[];
}) => {
  const fsModule = loadOptionalBuiltin("node:fs");
  if (!fsModule) return;

  const checks = createAccessChecks({ cwd, denyRead, denyWrite });

  wrapMethods(
    fsModule,
    [
      "writeFile",
      "writeFileSync",
      "appendFile",
      "appendFileSync",
      "truncate",
      "truncateSync",
      "unlink",
      "unlinkSync",
      "rm",
      "rmSync",
      "rmdir",
      "rmdirSync",
      "mkdir",
      "mkdirSync",
      "chmod",
      "chmodSync",
      "chown",
      "chownSync",
      "utimes",
      "utimesSync",
      "createWriteStream",
    ],
    checks.writeAt(0),
  );

  wrapMethods(
    fsModule,
    [
      "readFile",
      "readFileSync",
      "existsSync",
      "readdir",
      "readdirSync",
      "stat",
      "statSync",
      "lstat",
      "lstatSync",
      "readlink",
      "readlinkSync",
      "realpath",
      "realpathSync",
      "opendir",
      "opendirSync",
      "access",
      "accessSync",
      "createReadStream",
      "watch",
      "watchFile",
    ],
    checks.readAt(0),
  );

  wrapMethods(
    fsModule,
    [
      "rename",
      "renameSync",
      "copyFile",
      "copyFileSync",
      "cp",
      "cpSync",
      "link",
      "linkSync",
      "symlink",
      "symlinkSync",
    ],
    checks.readWriteAt(0, 1),
  );

  safeWrap(fsModule, "open", checks.nodeOpen);
  safeWrap(fsModule, "openSync", checks.nodeOpen);

  const promises = fsModule.promises as Record<string, unknown> | undefined;
  if (!promises) return;

  wrapMethods(
    promises,
    [
      "writeFile",
      "appendFile",
      "truncate",
      "unlink",
      "rm",
      "rmdir",
      "mkdir",
      "chmod",
      "chown",
      "utimes",
    ],
    checks.writeAt(0),
  );

  wrapMethods(
    promises,
    [
      "readFile",
      "readdir",
      "stat",
      "lstat",
      "readlink",
      "realpath",
      "opendir",
      "access",
      "watch",
    ],
    checks.readAt(0),
  );

  wrapMethods(
    promises,
    ["rename", "copyFile", "cp", "link", "symlink"],
    checks.readWriteAt(0, 1),
  );

  safeWrap(promises, "open", checks.nodeOpen);
  maybeSyncBuiltinESMExports?.();
};

const installNodeProcessGuard = (): void => {
  const runAt = (index: number, fallback: string) =>
    (args: unknown[]): DeniedAccess => ({
      target: args[index] ?? fallback,
      mode: "run",
    });

  let wrappedAny = false;
  for (const moduleId of ["node:child_process", "child_process"] as const) {
    const childProcess = loadOptionalBuiltin(moduleId);
    if (!childProcess) continue;
    wrapMethods(
      childProcess,
      [
        "spawn",
        "spawnSync",
        "exec",
        "execSync",
        "execFile",
        "execFileSync",
        "fork",
      ],
      runAt(0, moduleId),
    );
    wrappedAny = true;
  }

  if (wrappedAny) {
    maybeSyncBuiltinESMExports?.();
  }
};

const installNodeInternalsGuard = (): void => {
  if (typeof process === "undefined") return;
  const proc = process as NodeJS.Process & {
    binding?: (name: string, ...args: unknown[]) => unknown;
    _linkedBinding?: (name: string, ...args: unknown[]) => unknown;
    dlopen?: (...args: unknown[]) => unknown;
  };
  const block = (name: string): never => {
    throw new Error(
      `KNT_ERROR_PERMISSION_DENIED: run access denied for ${name}`,
    );
  };
  const dangerousBindingNames = new Set(["spawn_sync", "spawn_wrap"]);

  const wrapBinding = (
    method: "binding" | "_linkedBinding",
  ): void => {
    const original = proc[method];
    if (typeof original !== "function") return;
    if ((original as { [WRAPPED]?: boolean })[WRAPPED] === true) return;

    const wrapped = ((name: string, ...rest: unknown[]) => {
      if (dangerousBindingNames.has(name)) {
        return block(`process.${method}(${name})`);
      }
      return Reflect.apply(original, proc, [name, ...rest]);
    }) as typeof original & { [WRAPPED]?: boolean };

    wrapped[WRAPPED] = true;
    try {
      Object.defineProperty(proc, method, {
        configurable: false,
        writable: false,
        value: wrapped,
      });
    } catch (defineError) {
      try {
        (proc as unknown as Record<string, unknown>)[method] = wrapped;
      } catch (assignError) {
        failGuardInstall(`process.${method}`, "install failed", [
          toErrorMessage(defineError),
          toErrorMessage(assignError),
        ].join("; "));
      }
    }

    const installed = proc[method];
    if (
      typeof installed !== "function" ||
      (installed as { [WRAPPED]?: boolean })[WRAPPED] !== true
    ) {
      failGuardInstall(`process.${method}`, "install verification failed");
    }
  };

  wrapBinding("binding");
  wrapBinding("_linkedBinding");

  const originalDlopen = proc.dlopen;
  if (
    typeof originalDlopen === "function" &&
    (originalDlopen as { [WRAPPED]?: boolean })[WRAPPED] !== true
  ) {
    const wrappedDlopen = ((..._args: unknown[]) =>
      block("process.dlopen")) as typeof originalDlopen & { [WRAPPED]?: boolean };
    wrappedDlopen[WRAPPED] = true;
    try {
      Object.defineProperty(proc, "dlopen", {
        configurable: false,
        writable: false,
        value: wrappedDlopen,
      });
    } catch (defineError) {
      try {
        (proc as unknown as Record<string, unknown>).dlopen = wrappedDlopen;
      } catch (assignError) {
        failGuardInstall("process.dlopen", "install failed", [
          toErrorMessage(defineError),
          toErrorMessage(assignError),
        ].join("; "));
      }
    }

    const installed = proc.dlopen;
    if (
      typeof installed !== "function" ||
      (installed as { [WRAPPED]?: boolean })[WRAPPED] !== true
    ) {
      failGuardInstall("process.dlopen", "install verification failed");
    }
  }
};

const installWorkerSpawnGuard = (): void => {
  const g = globalThis as GlobalWithPermissionGuard;
  if (g.__knittingWorkerSpawnGuardInstalled === true) return;
  const blockWorker = (name: string): never => {
    throw new Error(
      `KNT_ERROR_PERMISSION_DENIED: run access denied for ${name}`,
    );
  };

  const workerThreads = loadOptionalBuiltin("node:worker_threads") as
    | { Worker?: unknown }
    | undefined;
  if (
    workerThreads &&
    typeof workerThreads.Worker === "function" &&
    (workerThreads.Worker as { [WRAPPED]?: boolean })[WRAPPED] !== true
  ) {
    const original = workerThreads.Worker as new (
      filename: string | URL,
      options?: unknown,
    ) => unknown;
    const wrapped = new Proxy(original, {
      apply(): never {
        return blockWorker("node:worker_threads.Worker");
      },
      construct(): never {
        return blockWorker("node:worker_threads.Worker");
      },
    });
    (wrapped as { [WRAPPED]?: boolean })[WRAPPED] = true;
    workerThreads.Worker = wrapped;
    maybeSyncBuiltinESMExports?.();
  }

  const globalWorker = g.Worker;
  if (
    typeof globalWorker === "function" &&
    (globalWorker as { [WRAPPED]?: boolean })[WRAPPED] !== true
  ) {
    const wrapped = new Proxy(
      globalWorker as new (...args: unknown[]) => unknown,
      {
        construct(): never {
          return blockWorker("Worker");
        },
      },
    );
    (wrapped as { [WRAPPED]?: boolean })[WRAPPED] = true;
    try {
      (g as unknown as Record<string, unknown>).Worker = wrapped;
    } catch (error) {
      failGuardInstall("globalThis.Worker", "install failed", error);
    }
    if (
      (g.Worker as unknown as { [WRAPPED]?: boolean } | undefined)?.[WRAPPED] !== true
    ) {
      failGuardInstall("globalThis.Worker", "install verification failed");
    }
  }

  g.__knittingWorkerSpawnGuardInstalled = true;
};

const installDenoGuard = ({
  cwd,
  denyRead,
  denyWrite,
  netAll,
  allowNet,
  denyNet,
  allowRun,
}: {
  cwd: string;
  denyRead: string[];
  denyWrite: string[];
  netAll: boolean;
  allowNet: readonly string[];
  denyNet: readonly string[];
  allowRun: boolean;
}) => {
  const g = globalThis as GlobalWithPermissionGuard;
  const deno = g.Deno;
  if (!deno) return;
  const checks = createAccessChecks({ cwd, denyRead, denyWrite });
  const networkPolicy: NetworkPolicy = {
    netAll,
    allow: allowNet,
    deny: denyNet,
  };

  wrapMethodsAndSync(
    deno,
    [
      "writeFile",
      "writeTextFile",
      "remove",
      "truncate",
      "mkdir",
      "chmod",
      "chown",
      "create",
    ],
    checks.writeAt(0),
  );

  wrapMethodsAndSync(
    deno,
    [
      "readFile",
      "readTextFile",
      "readDir",
      "readLink",
      "stat",
      "lstat",
      "realPath",
      "watchFs",
    ],
    checks.readAt(0),
  );

  safeWrap(deno, "open", checks.denoOpen);
  safeWrap(deno, "openSync", checks.denoOpen);

  wrapMethodsAndSync(
    deno,
    ["rename", "copyFile", "link", "symlink"],
    checks.readWriteAt(0, 1),
  );

  wrapMethods(
    deno,
    ["connect", "connectTls", "startTls", "listen", "listenTls"],
    createNetworkCheck({
      policy: networkPolicy,
      fallback: "Deno.connect",
      resolveEndpoint: resolveDenoConnectEndpoint,
    }),
  );

  if (allowRun !== true) {
    const runAt = (index: number, fallback: string) =>
      (args: unknown[]): DeniedAccess => ({
        target: args[index] ?? fallback,
        mode: "run",
      });

    wrapMethods(
      deno,
      ["run", "spawn", "spawnSync", "spawnChild"],
      runAt(0, "Deno.Command"),
    );

    try {
      const command = deno.Command as unknown;
      if (
        typeof command === "function" &&
        (command as { [WRAPPED]?: boolean })[WRAPPED] !== true
      ) {
        const wrapped = new Proxy(
          command as new (...args: unknown[]) => unknown,
          {
            construct(_target, args): never {
              return throwDeniedAccess(args[0] ?? "Deno.Command", "run");
            },
          },
        );
        (wrapped as { [WRAPPED]?: boolean })[WRAPPED] = true;
        (deno as unknown as Record<string, unknown>).Command = wrapped;
        if (
          (deno.Command as unknown as { [WRAPPED]?: boolean } | undefined)?.[WRAPPED] !==
            true
        ) {
          failGuardInstall("Deno.Command", "install verification failed");
        }
      }
    } catch (error) {
      failGuardInstall("Deno.Command", "install failed", error);
    }
  }
};

const installBunGuard = ({
  cwd,
  denyRead,
  denyWrite,
  netAll,
  allowNet,
  denyNet,
  allowRun,
}: {
  cwd: string;
  denyRead: string[];
  denyWrite: string[];
  netAll: boolean;
  allowNet: readonly string[];
  denyNet: readonly string[];
  allowRun: boolean;
}) => {
  const g = globalThis as GlobalWithPermissionGuard;
  const bun = g.Bun;
  if (!bun) return;
  const checks = createAccessChecks({ cwd, denyRead, denyWrite });
  const networkPolicy: NetworkPolicy = {
    netAll,
    allow: allowNet,
    deny: denyNet,
  };

  safeWrap(bun, "write", checks.writeAt(0));
  safeWrap(bun, "file", checks.readAt(0));
  safeWrap(
    bun,
    "serve",
    createNetworkCheck({
      policy: networkPolicy,
      fallback: "Bun.serve",
      resolveEndpoint: resolveBunServeEndpoint,
    }),
  );
  safeWrap(
    bun,
    "connect",
    createNetworkCheck({
      policy: networkPolicy,
      fallback: "Bun.connect",
      resolveEndpoint: resolveDenoConnectEndpoint,
    }),
  );
  safeWrap(bun, "dlopen", (_args) => ({
    target: "Bun.dlopen",
    mode: "run",
  }));
  safeWrap(bun, "linkSymbols", (_args) => ({
    target: "Bun.linkSymbols",
    mode: "run",
  }));
  if (allowRun !== true) {
    const runAt = (index: number, fallback: string) =>
      (args: unknown[]): DeniedAccess => ({
        target: args[index] ?? fallback,
        mode: "run",
      });
    wrapMethods(
      bun,
      ["spawn", "spawnSync", "$"],
      runAt(0, "Bun.spawn"),
    );
  }
};

export const installWritePermissionGuard = (
  protocol?: ResolvedPermissionProtocol,
): void => {
  if (!protocol || protocol.enabled !== true) return;

  if (protocol.allowConsole !== true) {
    installConsoleGuard();
  }
  if (protocol.unsafe === true) {
    return;
  }

  const g = globalThis as GlobalWithPermissionGuard;
  if (g.__knittingPermissionGuardInstalled === true) return;

  installNodeEnvGuard({
    allowAll: protocol.env.allowAll,
    allow: protocol.env.allow,
    deny: protocol.env.deny,
  });
  const networkPolicy: NetworkPolicy = {
    netAll: protocol.netAll,
    allow: protocol.net,
    deny: protocol.denyNet,
  };
  installNodeNetworkGuard(networkPolicy);

  if (protocol.node.allowChildProcess !== true) {
    installNodeProcessGuard();
    installNodeInternalsGuard();
    installWorkerSpawnGuard();
  }

  const { cwd, denyRead, denyWrite } = protocol;
  const shouldInstallFsGuards = (Array.isArray(denyRead) && denyRead.length > 0) ||
    (Array.isArray(denyWrite) && denyWrite.length > 0);

  if (shouldInstallFsGuards) {
    installNodeFsGuard({ cwd, denyRead, denyWrite });
  }
  installDenoGuard({
    cwd,
    denyRead,
    denyWrite,
    netAll: protocol.netAll,
    allowNet: protocol.net,
    denyNet: protocol.denyNet,
    allowRun: protocol.deno.allowRun,
  });
  installBunGuard({
    cwd,
    denyRead,
    denyWrite,
    netAll: protocol.netAll,
    allowNet: protocol.net,
    denyNet: protocol.denyNet,
    allowRun: protocol.bun.allowRun,
  });
  g.__knittingPermissionGuardInstalled = true;
};
