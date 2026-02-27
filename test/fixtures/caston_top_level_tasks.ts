import { task } from "../../knitting.ts";

const CAST_ON_TOP_LEVEL_KEY = "__knittingCastOnTopLevelValue";

const topLevelMutationState = (() => {
  try {
    (globalThis as Record<string, unknown>)[CAST_ON_TOP_LEVEL_KEY] = 99;
    return "mutated";
  } catch (error) {
    return String(error);
  }
})();

export const readCastOnTopLevelMutation = task<void, {
  value: number;
  topLevelMutationState: string;
}>({
  f: () => {
    const value = (globalThis as Record<string, unknown>)[CAST_ON_TOP_LEVEL_KEY];
    return {
      value: typeof value === "number" ? value : -1,
      topLevelMutationState,
    };
  },
});
