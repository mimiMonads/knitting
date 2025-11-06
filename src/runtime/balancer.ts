import type { Balancer, CreateContext } from "../types.ts";

export type Handler<A, R> = (args: A) => R;

type manager = {
  contexts: readonly CreateContext[];
  balancer?: Balancer;
  handlers: Function[];
};

export const managerMethod = ({ contexts, balancer, handlers }: manager) => {
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
      return roundRobin(contexts)(handlers)(max ?? handlers.length);
    case "firstIdle":
      return firstIdle(contexts)(handlers)(max ?? handlers.length);
    case "randomLane":
      return randomLane(contexts)(handlers)(max ?? handlers.length);
    case "firstIdleOrRandom":
      return firstIdleRandom(contexts)(handlers)(max ?? handlers.length);
  }

  // Unreachable code, but just in case uwu
  throw new Error(`Unknown balancer: ${balancer}`);
};

export function roundRobin(
  _contexts: readonly CreateContext[],
) {
  return (
    handlers: Function[],
  ) => {
    return (max: number) => {
      let rrCursor = -1;
      const toIndex = max - 1;
      return (
        args: any,
      ) => {
        return handlers[rrCursor === toIndex ? rrCursor = 0 : ++rrCursor](args);
      };
    };
  };
}

export function firstIdle(
  contexts: readonly CreateContext[],
) {
  const isSolved: Array<() => boolean> = contexts.map(
    (ctx) => ctx.txIdle,
  );

  return (
    handlers: Function[],
  ) => {
    return (max: number) => {
      let rrCursor = 0;
      const top = Math.min(max, handlers.length);
      return (args: any) => {
        for (let i = 0; i < handlers.length; i += 1) {
          if (isSolved[i]()) {
            return handlers[i](args);
          }
        }

        return handlers
          [rrCursor = (rrCursor + 1) % top](args);
      };
    };
  };
}

export const randomLane = (_: readonly CreateContext[]) => {
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

export function firstIdleRandom(
  contexts: readonly CreateContext[],
) {
  const isSolved: Array<() => boolean> = contexts.map(
    (ctx) => ctx.txIdle,
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
