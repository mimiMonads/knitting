import { getNodeProcess, type NodeProcessLike } from "../../common/node-compat.ts";

type NodeProcessWithUnhandledGuard = NodeProcessLike & {
  __knittingUnhandledRejectionSilencer?: boolean;
};

type NodeProcessWithTerminationGuard = NodeProcessLike & {
  __knittingTerminationGuard?: boolean;
  reallyExit?: (code?: number) => never;
  exit?: (code?: number) => never;
  kill?: (...args: unknown[]) => unknown;
  abort?: () => never;
};

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const failProcessGuardInstall = (
  target: string,
  reason: string,
  cause?: unknown,
): never => {
  const suffix = cause === undefined ? "" : `: ${toErrorMessage(cause)}`;
  throw new Error(`KNT_ERROR_PROCESS_GUARD_INSTALL: ${target} ${reason}${suffix}`);
};

export const installTerminationGuard = (): void => {
  const proc = getNodeProcess() as NodeProcessWithTerminationGuard | undefined;
  if (!proc) return;
  if (proc.__knittingTerminationGuard === true) return;

  const blocked = (name: string): never => {
    throw new Error(`KNT_ERROR_PROCESS_GUARD: ${name} is disabled in worker tasks`);
  };

  const guardMethod = (name: "exit" | "kill" | "abort" | "reallyExit") => {
    try {
      Object.defineProperty(proc, name, {
        configurable: false,
        writable: false,
        value: (..._args: unknown[]) => blocked(`process.${name}`),
      });
    } catch (defineError) {
      try {
        (proc as unknown as Record<string, unknown>)[name] = (..._args: unknown[]) =>
          blocked(`process.${name}`);
      } catch (assignError) {
        failProcessGuardInstall(`process.${name}`, "install failed", [
          toErrorMessage(defineError),
          toErrorMessage(assignError),
        ].join("; "));
      }
    }
    if (typeof (proc as unknown as Record<string, unknown>)[name] !== "function") {
      failProcessGuardInstall(`process.${name}`, "install verification failed");
    }
  };

  guardMethod("exit");
  guardMethod("kill");
  guardMethod("abort");
  guardMethod("reallyExit");

  const globalScope = globalThis as typeof globalThis & {
    Deno?: { exit?: (code?: number) => never };
  };

  if (globalScope.Deno && typeof globalScope.Deno.exit === "function") {
    try {
      Object.defineProperty(globalScope.Deno, "exit", {
        configurable: false,
        writable: false,
        value: (_code?: number) => blocked("Deno.exit"),
      });
    } catch (defineError) {
      try {
        (globalScope.Deno as unknown as Record<string, unknown>).exit = (_code?: number) =>
          blocked("Deno.exit");
      } catch (assignError) {
        failProcessGuardInstall("Deno.exit", "install failed", [
          toErrorMessage(defineError),
          toErrorMessage(assignError),
        ].join("; "));
      }
    }
    if (typeof (globalScope.Deno as { exit?: unknown }).exit !== "function") {
      failProcessGuardInstall("Deno.exit", "install verification failed");
    }
  }
  proc.__knittingTerminationGuard = true;
};

export const installUnhandledRejectionSilencer = (): void => {
  const proc = getNodeProcess() as NodeProcessWithUnhandledGuard | undefined;
  if (!proc || typeof proc.on !== "function") {
    return;
  }
  if (proc.__knittingUnhandledRejectionSilencer === true) return;
  proc.__knittingUnhandledRejectionSilencer = true;

  // Worker task code may create detached promises; keep workers alive.
  proc.on("unhandledRejection", () => {});
};
