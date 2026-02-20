import { task } from "../../knitting.ts";

export const returnLocalSymbol = task<void, symbol>({
  f: async () => Symbol("local"),
});

export const returnFunction = task<void, () => void>({
  f: async () => function nonSerializableReturn() {},
});

export const returnWeakMap = task<void, WeakMap<object, object>>({
  f: async () => new WeakMap(),
});

export const detachedUnhandledRejection = task<void, string>({
  f: async () => {
    Promise.resolve().then(() => {
      throw new Error("detached-unhandled");
    });
    return "ok";
  },
});
