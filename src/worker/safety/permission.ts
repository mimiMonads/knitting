import path from "node:path";
import { createRequire } from "node:module";
import type { ResolvedPermisonProtocol } from "../../permison/protocol.ts";
import { fileURLToPath } from "node:url";

type GlobalWithPermissionGuard = typeof globalThis & {
  __knittingPermissionGuardInstalled?: boolean;
  __knittingConsoleGuardInstalled?: boolean;
  Deno?: Record<string, unknown>;
  Bun?: Record<string, unknown>;
  console?: Record<string, unknown>;
};

const WRAPPED = Symbol.for("knitting.permission.wrapped");
const require = createRequire(import.meta.url);
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

const isPathWithin = (base: string, candidate: string): boolean => {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const toStringPath = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (value instanceof URL) {
    if (value.protocol === "file:") return fileURLToPath(value);
    return undefined;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "toString" in value &&
    typeof (value as { toString: unknown }).toString === "function"
  ) {
    const out = String((value as { toString: () => string }).toString());
    return out.length > 0 ? out : undefined;
  }
  return undefined;
};

const toAbsolutePath = (value: unknown, cwd: string): string | undefined => {
  const raw = toStringPath(value);
  if (!raw) return undefined;
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
  const resolved = toAbsolutePath(value, cwd);
  if (!resolved) return false;
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

const throwDeniedAccess = (target: unknown, mode: "read" | "write"): never => {
  throw new Error(
    `KNT_ERROR_PERMISSION_DENIED: ${mode} access denied for ${String(target)}`,
  );
};

type DeniedAccess = { target: unknown; mode: "read" | "write" };

const safeWrap = (
  target: Record<string, unknown>,
  method: string,
  check: (args: unknown[]) => DeniedAccess | undefined,
) => {
  try {
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
    target[method] = wrapped;
  } catch {
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
  const readAt = (index: number) => (args: unknown[]): DeniedAccess | undefined =>
    shouldDenyPath(args[index], cwd, denyRead)
      ? { target: args[index], mode: "read" }
      : undefined;
  const writeAt = (index: number) => (args: unknown[]): DeniedAccess | undefined =>
    shouldDenyPath(args[index], cwd, denyWrite)
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
  try {
    const fsModule = require("node:fs") as Record<string, unknown>;
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
      ["rename", "renameSync", "copyFile", "copyFileSync"],
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

    wrapMethods(promises, ["rename", "copyFile"], checks.readWriteAt(0, 1));

    safeWrap(promises, "open", checks.nodeOpen);
    maybeSyncBuiltinESMExports?.();
  } catch {
  }
};

const installDenoGuard = ({
  cwd,
  denyRead,
  denyWrite,
}: {
  cwd: string;
  denyRead: string[];
  denyWrite: string[];
}) => {
  const g = globalThis as GlobalWithPermissionGuard;
  const deno = g.Deno;
  if (!deno) return;
  const checks = createAccessChecks({ cwd, denyRead, denyWrite });

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
};

const installBunGuard = ({
  cwd,
  denyRead,
  denyWrite,
}: {
  cwd: string;
  denyRead: string[];
  denyWrite: string[];
}) => {
  const g = globalThis as GlobalWithPermissionGuard;
  const bun = g.Bun;
  if (!bun) return;
  const checks = createAccessChecks({ cwd, denyRead, denyWrite });

  safeWrap(bun, "write", checks.writeAt(0));
  safeWrap(bun, "file", checks.readAt(0));
};

export const installWritePermissionGuard = (
  protocol?: ResolvedPermisonProtocol,
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
  g.__knittingPermissionGuardInstalled = true;

  const { cwd, denyRead, denyWrite } = protocol;
  if (
    (!Array.isArray(denyRead) || denyRead.length === 0) &&
    (!Array.isArray(denyWrite) || denyWrite.length === 0)
  ) {
    return;
  }

  installNodeFsGuard({ cwd, denyRead, denyWrite });
  installDenoGuard({ cwd, denyRead, denyWrite });
  installBunGuard({ cwd, denyRead, denyWrite });
};
