import { castOn, task } from "../../knitting.ts";

const CAST_ON_VALUE_KEY = "__knittingCastOnValue";
const CAST_ON_OBJECT_KEY = "__knittingCastOnObjectValue";
const CAST_ON_ASYNC_KEY = "__knittingCastOnAsyncValue";
const CAST_ON_TOP_LEVEL_KEY = "__knittingCastOnTopLevelValue";
const CAST_ON_EXISTING_GLOBAL_READY = "__knittingCastOnExistingGlobalReady";
const EXISTING_GLOBAL_KEY = "atob";

export const setupCastOnValue = castOn({
  f: () => {
    (globalThis as Record<string, unknown>)[CAST_ON_VALUE_KEY] = 41;
  },
});

export const setupCastOnObjectValue = castOn({
  f: () => {
    (globalThis as Record<string, unknown>)[CAST_ON_OBJECT_KEY] = {
      count: 1,
    };
  },
});

export const readCastOnValue = task<void, number>({
  f: () => {
    const value = (globalThis as Record<string, unknown>)[CAST_ON_VALUE_KEY];
    return typeof value === "number" ? value : -1;
  },
});

export const mutateCastOnValue = task<void, string>({
  f: () => {
    try {
      (globalThis as Record<string, unknown>)[CAST_ON_VALUE_KEY] = 0;
      return "mutated";
    } catch (error) {
      return String(error);
    }
  },
});

export const readCastOnObjectValue = task<void, {
  count: number;
  hasInjected: boolean;
}>({
  f: () => {
    const value = (globalThis as Record<string, unknown>)[CAST_ON_OBJECT_KEY];
    if (!value || typeof value !== "object") {
      return { count: -1, hasInjected: false };
    }
    const obj = value as Record<string, unknown>;
    return {
      count: typeof obj.count === "number" ? obj.count : -1,
      hasInjected: "injected" in obj,
    };
  },
});

export const mutateCastOnObjectValue = task<void, string>({
  f: () => {
    const value = (globalThis as Record<string, unknown>)[CAST_ON_OBJECT_KEY];
    if (!value || typeof value !== "object") return "missing";
    try {
      const obj = value as Record<string, unknown>;
      obj.count = 2;
      obj.injected = true;
      return "mutated";
    } catch (error) {
      return String(error);
    }
  },
});

export const setupCastOnAsyncValue = castOn({
  f: async () => {
    await Promise.resolve();
    (globalThis as Record<string, unknown>)[CAST_ON_ASYNC_KEY] = "ready";
  },
});

export const readCastOnAsyncValue = task<void, string>({
  f: () => {
    const value = (globalThis as Record<string, unknown>)[CAST_ON_ASYNC_KEY];
    return typeof value === "string" ? value : "missing";
  },
});

export const setupCastOnTopLevelValue = castOn({
  f: () => {
    (globalThis as Record<string, unknown>)[CAST_ON_TOP_LEVEL_KEY] = 41;
  },
});

export const setupCastOnExistingGlobal = castOn({
  f: () => {
    const g = globalThis as Record<string, unknown>;
    let ready = false;
    try {
      if (typeof g[EXISTING_GLOBAL_KEY] === "function") {
        g[EXISTING_GLOBAL_KEY] = function castOnAtob() {
          return "caston";
        };
        ready = true;
      }
    } catch {
      ready = false;
    }
    g[CAST_ON_EXISTING_GLOBAL_READY] = ready;
  },
});

export const readCastOnExistingGlobal = task<void, {
  ready: boolean;
  name: string;
}>({
  f: () => {
    const g = globalThis as Record<string, unknown>;
    const fn = g[EXISTING_GLOBAL_KEY];
    return {
      ready: g[CAST_ON_EXISTING_GLOBAL_READY] === true,
      name: typeof fn === "function" ? String((fn as Function).name || "anon") : typeof fn,
    };
  },
});

export const mutateCastOnExistingGlobal = task<void, string>({
  f: () => {
    const g = globalThis as Record<string, unknown>;
    if (g[CAST_ON_EXISTING_GLOBAL_READY] !== true) {
      return "skipped";
    }
    try {
      g[EXISTING_GLOBAL_KEY] = function taskAtob() {
        return "task";
      };
      const fn = g[EXISTING_GLOBAL_KEY];
      return typeof fn === "function" ? String((fn as Function).name || "anon") : typeof fn;
    } catch (error) {
      return String(error);
    }
  },
});
