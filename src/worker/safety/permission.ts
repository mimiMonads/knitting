import path from "node:path";
import { createRequire } from "node:module";
import type { ResolvedPermisonProtocol } from "../../permison/protocol.ts";
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
  const resolveCanonical = (candidate: string): string => {
    const realpath = rawRealpathSync;
    const direct = (() => {
      if (!realpath) return undefined;
      try {
        return realpath(candidate);
      } catch {
        return undefined;
      }
    })();
    if (direct) return path.resolve(direct);
    if (!rawExistsSync || !realpath) {
      return path.resolve(candidate);
    }

    const missingSegments: string[] = [];
    let cursor = path.resolve(candidate);
    while (!rawExistsSync(cursor)) {
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(candidate);
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

  const absolute = toAbsolutePath(value, cwd);
  if (!absolute) return false;
  const resolved = resolveCanonical(absolute);
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

const installNodeProcessGuard = (): void => {
  try {
    const childProcess = require("node:child_process") as Record<string, unknown>;
    const runAt = (index: number, fallback: string) =>
      (args: unknown[]): DeniedAccess => ({
        target: args[index] ?? fallback,
        mode: "run",
      });

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
      runAt(0, "node:child_process"),
    );
    maybeSyncBuiltinESMExports?.();
  } catch {
  }
};

const installNodeInternalsGuard = (): void => {
  if (typeof process === "undefined") return;
  const proc = process as NodeJS.Process & {
    binding?: (name: string) => unknown;
    _linkedBinding?: (name: string) => unknown;
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
      return original.call(proc, name, ...rest);
    }) as typeof original & { [WRAPPED]?: boolean };

    wrapped[WRAPPED] = true;
    try {
      Object.defineProperty(proc, method, {
        configurable: false,
        writable: false,
        value: wrapped,
      });
    } catch {
      try {
        (proc as Record<string, unknown>)[method] = wrapped;
      } catch {
      }
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
    } catch {
      try {
        (proc as Record<string, unknown>).dlopen = wrappedDlopen;
      } catch {
      }
    }
  }
};

const installWorkerSpawnGuard = (): void => {
  const g = globalThis as GlobalWithPermissionGuard;
  if (g.__knittingWorkerSpawnGuardInstalled === true) return;
  g.__knittingWorkerSpawnGuardInstalled = true;
  const blockWorker = (name: string): never => {
    throw new Error(
      `KNT_ERROR_PERMISSION_DENIED: run access denied for ${name}`,
    );
  };

  try {
    const workerThreads = require("node:worker_threads") as {
      Worker?: unknown;
    };
    if (
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
  } catch {
  }

  const globalWorker = g.Worker;
  if (
    typeof globalWorker === "function" &&
    (globalWorker as { [WRAPPED]?: boolean })[WRAPPED] !== true
  ) {
    try {
      const wrapped = new Proxy(globalWorker as (...args: unknown[]) => unknown, {
        apply(): never {
          return blockWorker("Worker");
        },
        construct(): never {
          return blockWorker("Worker");
        },
      });
      (wrapped as { [WRAPPED]?: boolean })[WRAPPED] = true;
      g.Worker = wrapped;
    } catch {
    }
  }
};

const installDenoGuard = ({
  cwd,
  denyRead,
  denyWrite,
  allowRun,
}: {
  cwd: string;
  denyRead: string[];
  denyWrite: string[];
  allowRun: boolean;
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
        const wrapped = new Proxy(command as (...args: unknown[]) => unknown, {
          apply(_target, _thisArg, args): never {
            return throwDeniedAccess(args[0] ?? "Deno.Command", "run");
          },
          construct(_target, args): never {
            return throwDeniedAccess(args[0] ?? "Deno.Command", "run");
          },
        });
        (wrapped as { [WRAPPED]?: boolean })[WRAPPED] = true;
        deno.Command = wrapped;
      }
    } catch {
    }
  }
};

const installBunGuard = ({
  cwd,
  denyRead,
  denyWrite,
  allowRun,
}: {
  cwd: string;
  denyRead: string[];
  denyWrite: string[];
  allowRun: boolean;
}) => {
  const g = globalThis as GlobalWithPermissionGuard;
  const bun = g.Bun;
  if (!bun) return;
  const checks = createAccessChecks({ cwd, denyRead, denyWrite });

  safeWrap(bun, "write", checks.writeAt(0));
  safeWrap(bun, "file", checks.readAt(0));
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

  if (protocol.node.allowChildProcess !== true) {
    installNodeProcessGuard();
    installNodeInternalsGuard();
    installWorkerSpawnGuard();
  }

  const { cwd, denyRead, denyWrite } = protocol;
  if (
    (!Array.isArray(denyRead) || denyRead.length === 0) &&
    (!Array.isArray(denyWrite) || denyWrite.length === 0)
  ) {
    return;
  }

  installNodeFsGuard({ cwd, denyRead, denyWrite });
  installDenoGuard({
    cwd,
    denyRead,
    denyWrite,
    allowRun: protocol.deno.allowRun,
  });
  installBunGuard({
    cwd,
    denyRead,
    denyWrite,
    allowRun: protocol.bun.allowRun,
  });
};
