import type {
  PermissionProtocolInput,
  ResolvedPermissionProtocol,
} from "./protocol.ts";

type ProcessPermissionRuntime = "bun" | "deno" | "node";
type PermissionCompatibilityLevel = "exact" | "coarse" | "unsupported";

type ProcessPermissionTarget = {
  runtime: ProcessPermissionRuntime;
  /**
   * Omitted when a wrapper or another host runtime makes the Node version
   * impossible to prove synchronously.
   */
  nodeMajor?: number;
};

type PermissionCompatibilityCheck = {
  permission: string;
  level: PermissionCompatibilityLevel;
  explicit: boolean;
  reason: string;
};

type ProcessPermissionCompatibilityReport = {
  target: ProcessPermissionTarget;
  checks: PermissionCompatibilityCheck[];
};

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const hasExplicit = (
  value: Record<string, unknown> | undefined,
  key: string,
): boolean => value !== undefined && hasOwn(value, key);

const hasNonEmptyArray = (
  value: Record<string, unknown> | undefined,
  key: string,
): boolean => Array.isArray(value?.[key]) && value[key].length > 0;

const explicitProtocolObject = (
  permission: PermissionProtocolInput | undefined,
): Record<string, unknown> | undefined =>
  permission != null && typeof permission === "object"
    ? permission as Record<string, unknown>
    : undefined;

const explicitNestedObject = (
  input: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined => {
  const value = input?.[key];
  return value != null && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
};

const targetLabel = (target: ProcessPermissionTarget): string => {
  if (target.runtime !== "node") {
    return `${target.runtime[0]!.toUpperCase()}${target.runtime.slice(1)}`;
  }
  return target.nodeMajor === undefined
    ? "Node (version unknown)"
    : `Node ${target.nodeMajor}`;
};

const nodeTargetUsesFfiTransport = (
  target: ProcessPermissionTarget,
): boolean =>
  target.runtime === "node" &&
  target.nodeMajor !== undefined &&
  target.nodeMajor >= 26 &&
  target.nodeMajor % 2 === 0;

const permissionCheck = (
  permission: string,
  level: PermissionCompatibilityLevel,
  reason: string,
): Omit<PermissionCompatibilityCheck, "explicit"> => ({
  permission,
  level,
  reason,
});

const classifyRestriction = ({
  target,
  permission,
  scoped,
  processNativeTransport = false,
}: {
  target: ProcessPermissionTarget;
  permission: string;
  scoped?: boolean;
  processNativeTransport?: boolean;
}): Omit<PermissionCompatibilityCheck, "explicit"> => {
  const label = targetLabel(target);
  const exact = (reason: string) =>
    permissionCheck(permission, "exact", reason);
  const coarse = (reason: string) =>
    permissionCheck(permission, "coarse", reason);
  const unsupported = (reason: string) =>
    permissionCheck(permission, "unsupported", reason);

  if (target.runtime === "bun") {
    return unsupported(
      "Bun process workers do not expose a matching runtime permission control.",
    );
  }

  if (target.runtime === "deno") {
    if (permission === "workers") {
      return unsupported(
        "Knitting does not currently configure a Deno worker-spawn restriction.",
      );
    }
    if (permission === "wasi") {
      return unsupported(
        "Deno does not expose a matching Knitting WASI process permission.",
      );
    }
    if (
      processNativeTransport &&
      (permission === "ffi" || permission === "denyFfi")
    ) {
      return unsupported(
        "Deno process workers require --allow-ffi for Knitting's shared-memory transport.",
      );
    }
    return exact(
      "Deno can represent this restriction with scoped runtime flags.",
    );
  }

  if (permission === "read" || permission === "write") {
    return exact(`${label} supports scoped filesystem allow rules.`);
  }
  if (permission === "run") {
    return scoped
      ? coarse(
        `${label} can only allow or deny all child processes, not an executable allow-list.`,
      )
      : exact(`${label} can deny all child processes.`);
  }
  if (permission === "workers") {
    return exact(`${label} can deny worker creation.`);
  }
  if (permission === "wasi") {
    return exact(`${label} can deny WASI.`);
  }
  if (permission === "net") {
    if (target.nodeMajor === undefined) {
      return unsupported(
        "The Node version is unknown, so Knitting cannot prove that network denial is available.",
      );
    }
    if (target.nodeMajor < 25) {
      return unsupported(`${label} has no network permission control.`);
    }
    return scoped
      ? coarse(
        `${label} --allow-net is all-or-nothing and cannot enforce a host allow-list.`,
      )
      : exact(`${label} denies network access when --allow-net is omitted.`);
  }
  if (permission === "node.allowAddons") {
    if (nodeTargetUsesFfiTransport(target)) {
      return exact(
        `${label} uses node:ffi rather than addons for Knitting's process transport.`,
      );
    }
    return unsupported(
      `${label} process workers require addon permission for Knitting's shared-memory transport.`,
    );
  }
  if (permission === "node.allowFfi") {
    if (
      target.nodeMajor !== undefined &&
      !nodeTargetUsesFfiTransport(target)
    ) {
      return exact(
        `${label} does not use node:ffi for Knitting's process transport.`,
      );
    }
    return unsupported(
      `${label} process workers require node:ffi permission for Knitting's shared-memory transport.`,
    );
  }
  if (
    processNativeTransport &&
    (permission === "ffi" || permission === "denyFfi")
  ) {
    return unsupported(
      `${label} process workers require native-code permission for Knitting's shared-memory transport.`,
    );
  }

  const unsupportedReasons: Record<string, string> = {
    denyRead: `${label} has no filesystem deny-list control.`,
    denyWrite: `${label} has no filesystem deny-list control.`,
    denyNet: `${label} has no network deny-list control.`,
    allowImport: `${label} has no import-host allow-list control.`,
    env: `${label} has no environment-variable permission control.`,
    denyEnv: `${label} has no environment-variable deny-list control.`,
    denyRun: `${label} has no child-process deny-list control.`,
    sys: `${label} has no system-information permission control.`,
    denySys: `${label} has no system-information deny-list control.`,
  };

  return unsupported(
    unsupportedReasons[permission] ??
      `${label} cannot represent this restriction.`,
  );
};

export const classifyProcessPermissionCompatibility = ({
  permission,
  resolved,
  target,
}: {
  permission: PermissionProtocolInput | undefined;
  resolved: ResolvedPermissionProtocol | undefined;
  target: ProcessPermissionTarget;
}): ProcessPermissionCompatibilityReport => {
  if (
    resolved?.enabled !== true ||
    resolved.unsafe === true ||
    permission === "unsafe" ||
    permission === "off"
  ) {
    return { target, checks: [] };
  }

  const input = explicitProtocolObject(permission);
  const envInput = explicitNestedObject(input, "env");
  const nodeInput = explicitNestedObject(input, "node");
  const denoInput = explicitNestedObject(input, "deno");
  const checks: PermissionCompatibilityCheck[] = [];
  const add = (
    permissionName: string,
    explicit: boolean,
    options: { scoped?: boolean; processNativeTransport?: boolean } = {},
  ) => {
    checks.push({
      ...classifyRestriction({
        target,
        permission: permissionName,
        ...options,
      }),
      explicit,
    });
  };

  if (!resolved.readAll) {
    add("read", hasExplicit(input, "read"), {
      scoped: resolved.read.length > 0,
    });
  }
  if (!resolved.writeAll) {
    add("write", hasExplicit(input, "write"), {
      scoped: resolved.write.length > 0,
    });
  }
  if (resolved.denyRead.length > 0) {
    add("denyRead", hasNonEmptyArray(input, "denyRead"));
  }
  if (resolved.denyWrite.length > 0) {
    add("denyWrite", hasNonEmptyArray(input, "denyWrite"));
  }

  if (!resolved.netAll) {
    add("net", hasExplicit(input, "net"), {
      scoped: resolved.net.length > 0,
    });
  }
  if (resolved.denyNet.length > 0) {
    add("denyNet", hasNonEmptyArray(input, "denyNet"));
  }
  if (!resolved.allowImportAll) {
    add(
      "allowImport",
      hasExplicit(input, "allowImport"),
      { scoped: resolved.allowImport.length > 0 },
    );
  }

  if (!resolved.env.allowAll) {
    add("env", hasExplicit(envInput, "allow"), {
      scoped: resolved.env.allow.length > 0,
    });
  }
  if (resolved.env.deny.length > 0) {
    add("denyEnv", hasNonEmptyArray(envInput, "deny"));
  }

  if (!resolved.runAll) {
    const explicitRun = hasExplicit(input, "run") ||
      (target.runtime === "node" &&
        hasExplicit(nodeInput, "allowChildProcess")) ||
      (target.runtime === "deno" &&
        hasExplicit(denoInput, "allowRun"));
    add("run", explicitRun, { scoped: resolved.run.length > 0 });
  }
  if (resolved.denyRun.length > 0) {
    add("denyRun", hasNonEmptyArray(input, "denyRun"));
  }
  if (!resolved.workers) {
    const explicitWorkers = hasExplicit(input, "workers") ||
      (target.runtime === "node" &&
        hasExplicit(nodeInput, "allowWorker"));
    add("workers", explicitWorkers);
  }

  if (!resolved.ffiAll) {
    add("ffi", hasExplicit(input, "ffi"), {
      scoped: resolved.ffi.length > 0,
      processNativeTransport: true,
    });
  }
  if (resolved.denyFfi.length > 0) {
    add("denyFfi", hasNonEmptyArray(input, "denyFfi"), {
      processNativeTransport: !resolved.ffiAll,
    });
  }

  if (!resolved.sysAll) {
    add("sys", hasExplicit(input, "sys"), {
      scoped: resolved.sys.length > 0,
    });
  }
  if (resolved.denySys.length > 0) {
    add("denySys", hasNonEmptyArray(input, "denySys"));
  }
  if (!resolved.wasi) {
    const explicitWasi = hasExplicit(input, "wasi") ||
      (target.runtime === "node" &&
        hasExplicit(nodeInput, "allowWasi"));
    add("wasi", explicitWasi);
  }

  if (target.runtime === "node" && nodeInput !== undefined) {
    if (hasOwn(nodeInput, "allowAddons") && nodeInput.allowAddons === false) {
      add("node.allowAddons", true);
    }
    if (hasOwn(nodeInput, "allowFfi") && nodeInput.allowFfi === false) {
      add("node.allowFfi", true);
    }
  }

  return { target, checks };
};

const warningKeys = new Set<string>();

export const enforceProcessPermissionCompatibility = (
  report: ProcessPermissionCompatibilityReport,
): void => {
  const incompatible = report.checks.filter((check) => check.level !== "exact");
  const explicit = incompatible.filter((check) => check.explicit);
  const label = targetLabel(report.target);

  if (explicit.length > 0) {
    const details = explicit
      .map((check) =>
        `permission.${check.permission} is ${check.level}: ${check.reason}`
      )
      .join(" ");
    throw new Error(
      `knitting: ${label} process workers cannot enforce the requested permission policy. ` +
        `${details} Choose a runtime that can represent the restriction, add an OS sandbox, ` +
        `or remove the restriction only if broader access is acceptable.`,
    );
  }

  if (incompatible.length === 0) return;
  const names = [...new Set(incompatible.map((check) => check.permission))];
  const warningKey = label;
  if (warningKeys.has(warningKey)) return;
  warningKeys.add(warningKey);
  console.warn(
    `knitting: ${label} process workers cannot enforce every implicit strict ` +
      `permission default (${names.join(", ")}). Explicit unsupported ` +
      `restrictions fail closed; use an OS sandbox for hostile task code.`,
  );
};

export type {
  PermissionCompatibilityCheck,
  PermissionCompatibilityLevel,
  ProcessPermissionCompatibilityReport,
  ProcessPermissionRuntime,
  ProcessPermissionTarget,
};
