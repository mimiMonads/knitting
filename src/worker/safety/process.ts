type NodeProcessWithUnhandledGuard = NodeJS.Process & {
  __knittingUnhandledRejectionSilencer?: boolean;
};

type NodeProcessWithTerminationGuard = NodeJS.Process & {
  __knittingTerminationGuard?: boolean;
  reallyExit?: (code?: number) => never;
};

export const installTerminationGuard = (): void => {
  if (typeof process === "undefined") return;
  const proc = process as NodeProcessWithTerminationGuard;
  if (proc.__knittingTerminationGuard === true) return;
  proc.__knittingTerminationGuard = true;

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
    } catch {
    }
  };

  guardMethod("exit");
  guardMethod("kill");
  guardMethod("abort");
  guardMethod("reallyExit");

  const globalScope = globalThis as typeof globalThis & {
    Bun?: { exit?: (code?: number) => never };
    Deno?: { exit?: (code?: number) => never };
  };

  if (globalScope.Bun && typeof globalScope.Bun.exit === "function") {
    try {
      Object.defineProperty(globalScope.Bun, "exit", {
        configurable: false,
        writable: false,
        value: (_code?: number) => blocked("Bun.exit"),
      });
    } catch {
    }
  }

  if (globalScope.Deno && typeof globalScope.Deno.exit === "function") {
    try {
      Object.defineProperty(globalScope.Deno, "exit", {
        configurable: false,
        writable: false,
        value: (_code?: number) => blocked("Deno.exit"),
      });
    } catch {
    }
  }
};

export const installUnhandledRejectionSilencer = (): void => {
  if (typeof process === "undefined" || typeof process.on !== "function") {
    return;
  }
  const proc = process as NodeProcessWithUnhandledGuard;
  if (proc.__knittingUnhandledRejectionSilencer === true) return;
  proc.__knittingUnhandledRejectionSilencer = true;

  // Worker task code may create detached promises; keep workers alive.
  process.on("unhandledRejection", () => {});
};
