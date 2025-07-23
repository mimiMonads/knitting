import type { CreateContext } from "./threadManager.ts";

export type Handler<A, R> = (args: A) => R;

export type Balancer =
  | "robinRound"
  | "firstAvailable"
  | "randomBetweenThreads"
  | "firstAvailableRandom";

type Mananger = {
  contexts: readonly CreateContext[];
  balancer?: Balancer;
  handlers: Function[];
};

export const manangerMethod = ({ contexts, balancer, handlers }: Mananger) => {
  const max = handlers.length;

  if (contexts.length < 2) {
    throw new Error(
      contexts.length === 0
        ? "No threads available."
        : "Cannot rotate with a single thread.",
    );
  }

  if (handlers.length === 0) {
    throw new Error("No handlers provided.");
  }

  switch (balancer ?? "robinRound") {
    case "robinRound":
      return loopingBetweenThreads(contexts)(handlers)(max ?? handlers.length);
    case "firstAvailable":
      return firstAvailable(contexts)(handlers)(max ?? handlers.length);
    case "randomBetweenThreads":
      return randomBetweenThreads(contexts)(handlers)(max ?? handlers.length);
    case "firstAvailableRandom":
      return firstAvailableRandom(contexts)(handlers)(max ?? handlers.length);
  }

  // Unreachable code, but just in case uwu
  throw new Error(`Unknown balancer: ${balancer}`);
};

export function loopingBetweenThreads(
  _contexts: readonly CreateContext[],
) {
  return (
    handlers: Function[],
  ) => {
    return (max: number) => {
      let rrCursor = -1;
      return (
        args: any,
      ) => {
        const index =
          (rrCursor = (rrCursor + 1) % Math.min(max, handlers.length));
        return handlers[index](args);
      };
    };
  };
}

export function firstAvailable(
  contexts: readonly CreateContext[],
) {
  const isSolved: Array<() => boolean> = contexts.map(
    (ctx) => ctx.hasEverythingBeenSent,
  );

  return (
    handlers: Function[],
  ) => {
    return (max: number) => {
      let rrCursor = 0;

      return (args: any) => {
        for (let i = 0; i < handlers.length; i += 1) {
          if (isSolved[i]()) {
            return handlers[i](args);
          }
        }

        return handlers
          [rrCursor = (rrCursor + 1) % Math.min(max, handlers.length)](args);
      };
    };
  };
}

export const randomBetweenThreads = (_: readonly CreateContext[]) => {
  return (
    handlers: Function[],
  ) => {
    return (max: number) => {
      return (args: any) => {
        const index = Math.floor(
          Math.random() * Math.min(max, handlers.length),
        );
        return handlers[index](args);
      };
    };
  };
};

export function firstAvailableRandom(
  contexts: readonly CreateContext[],
) {
  const isSolved: Array<() => boolean> = contexts.map(
    (ctx) => ctx.hasEverythingBeenSent,
  );

  return (
    handlers: Function[],
  ) => {
    return (max: number) => {
      return (args: any) => {
        for (let i = 0; i < handlers.length; i += 1) {
          if (isSolved[i]()) {
            return handlers[i](args);
          }
        }

        const index = Math.floor(
          Math.random() * Math.min(max, handlers.length),
        );
        return handlers[index](args);
      };
    };
  };
}
