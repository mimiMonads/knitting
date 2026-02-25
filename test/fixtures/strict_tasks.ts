import { task } from "../../knitting.ts";

const strictTaskModuleTopLevelProcessType = typeof (
  globalThis as Record<string, unknown>
).process;
const strictTaskModuleTopLevelExecArgv = (
  globalThis as Record<string, unknown> & {
    process?: {
      execArgv?: string[];
    };
  }
).process?.execArgv ?? [];

export const readStrictRequireBinding = task<void, string>({
  f: () => {
    try {
      const g = globalThis as Record<string, unknown>;
      // Access triggers strict injected getter when enabled.
      return String(g.require);
    } catch (error) {
      return String(error);
    }
  },
});

export const readStrictModuleBinding = task<void, string>({
  f: () => {
    try {
      const g = globalThis as Record<string, unknown>;
      return String(g.module);
    } catch (error) {
      return String(error);
    }
  },
});

export const inspectStrictMembraneGlobals = task<void, {
  processType: string;
  bunType: string;
  webAssemblyType: string;
  fetchType: string;
  globalThisIsSelf: boolean;
  globalProtoIsNull: boolean;
  constructorEscape: string;
}>({
  f: () => {
    const g = globalThis as Record<string, unknown>;
    const constructorEscapeResult = (() => {
      try {
        const listCtor = ([] as unknown[]).constructor as {
          constructor: (source: string) => () => unknown;
          [key: string]: unknown;
        };
        const maybeCtor =
          listCtor["constructor"] as (source: string) => () => unknown;
        return String(maybeCtor("return typeof process")());
      } catch (error) {
        return String(error);
      }
    })();

    return {
      processType: typeof g.process,
      bunType: typeof g.Bun,
      webAssemblyType: typeof g.WebAssembly,
      fetchType: typeof g.fetch,
      globalThisIsSelf: g === (g.self as unknown),
      globalProtoIsNull: Object.getPrototypeOf(g) === null,
      constructorEscape: constructorEscapeResult,
    };
  },
});

export const readStrictModuleTopLevelProcessType = task<void, string>({
  f: () => strictTaskModuleTopLevelProcessType,
});

export const readStrictSandboxRuntimeState = task<void, {
  hasRuntime: boolean;
  vmEnabled: boolean;
  issueCount: number;
}>({
  f: () => {
    const runtime = (
      globalThis as Record<string, unknown> & {
        __knittingStrictSandboxRuntime?: {
          vmEnabled?: boolean;
          issues?: unknown[];
        };
      }
    ).__knittingStrictSandboxRuntime;
    return {
      hasRuntime: runtime != null,
      vmEnabled: runtime?.vmEnabled === true,
      issueCount: Array.isArray(runtime?.issues) ? runtime.issues.length : 0,
    };
  },
});

export const readStrictSandboxDiagnostics = task<void, {
  topLevelProcessType: string;
  topLevelExecArgv: string[];
  currentProcessType: string;
  hasRuntimeViaGlobal: boolean;
  vmEnabledViaGlobal: boolean;
}>({
  f: () => {
    const g = globalThis as Record<string, unknown> & {
      global?: {
        __knittingStrictSandboxRuntime?: {
          vmEnabled?: boolean;
        };
      };
    };
    const runtime = g.global?.__knittingStrictSandboxRuntime;
    return {
      topLevelProcessType: strictTaskModuleTopLevelProcessType,
      topLevelExecArgv: strictTaskModuleTopLevelExecArgv,
      currentProcessType: typeof g.process,
      hasRuntimeViaGlobal: runtime != null,
      vmEnabledViaGlobal: runtime?.vmEnabled === true,
    };
  },
});
