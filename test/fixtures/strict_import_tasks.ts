import { task } from "../../knitting.ts";

export const probeStrictEvalDynamicImport = task<void, string>({
  f: () => {
    try {
      const g = globalThis as Record<string, unknown>;
      const invoke = g["eva" + "l"] as (code: string) => unknown;
      const payload = ["im", "port", "(", "'node:fs'", ")"].join("");
      invoke(payload);
      return "allowed";
    } catch (error) {
      return String(error);
    }
  },
});

export const probeStrictEvalObfuscatedDynamicImport = task<void, string>({
  f: () => {
    try {
      const g = globalThis as Record<string, unknown>;
      const invoke = g["eva" + "l"] as (code: string) => unknown;
      const payload = [
        "im",
        "port",
        "(",
        "String.fromCharCode(110,111,100,101,58,102,115)",
        ")",
      ].join("");
      invoke(payload);
      return "allowed";
    } catch (error) {
      return String(error);
    }
  },
});

export const probeStrictFunctionCtorDynamicImport = task<void, string>({
  f: () => {
    try {
      const g = globalThis as Record<string, unknown>;
      const Factory = g["Funct" + "ion"] as new (
        ...args: string[]
      ) => () => unknown;
      const body = ["return ", "im", "port", "(", "'node:fs'", ")"].join("");
      const fn = new Factory(body);
      const value = fn();
      return typeof value;
    } catch (error) {
      return String(error);
    }
  },
});

export const probeStrictSandboxRequireModuleTypes = task<void, {
  requireType: string;
  moduleType: string;
}>({
  f: () => {
    const g = globalThis as Record<string, unknown>;
    return {
      requireType: typeof g.require,
      moduleType: typeof g.module,
    };
  },
});
