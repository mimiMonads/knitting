import type { Balancer, CreateContext } from "../types.ts";

export type Handler<A, R> = (args: A) => R;
type LaneHandler = (args: any) => Promise<unknown>;
type LaneInvoker = (args: any) => Promise<unknown>;

type manager = {
  contexts: readonly CreateContext[];
  balancer?: Balancer;
  handlers: LaneHandler[];
  inlinerGate?: {
    index: number;
    threshold: number;
  };
};

const selectStrategy = (
  contexts: readonly CreateContext[],
  handlers: LaneHandler[],
  strategy: manager["balancer"],
): LaneInvoker => {
  switch (strategy ?? "robinRound") {
    case "robinRound":
      return roundRobin(contexts)(handlers)(handlers.length);
    case "firstIdle":
      return firstIdle(contexts)(handlers)(handlers.length);
    case "randomLane":
      return randomLane(contexts)(handlers)(handlers.length);
    case "firstIdleOrRandom":
      return firstIdleRandom(contexts)(handlers)(handlers.length);
  }

  // Unreachable code, but guarded for safety.
  throw new Error(`Unknown balancer: ${strategy}`);
};

export const managerMethod = ({
  contexts,
  balancer,
  handlers,
  inlinerGate,
}: manager) => {
  const strategy = typeof balancer === "object" && balancer != null
    ? balancer.strategy
    : balancer;

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

  const allInvoker = selectStrategy(contexts, handlers, strategy);

  if (!inlinerGate) {
    return allInvoker;
  }

  const inlinerIndex = inlinerGate.index | 0;
  const threshold = Number.isFinite(inlinerGate.threshold)
    ? Math.max(1, Math.floor(inlinerGate.threshold))
    : 1;

  if (threshold <= 1 || inlinerIndex < 0 || inlinerIndex >= handlers.length) {
    return allInvoker;
  }

  const workerLaneCount = handlers.length - 1;
  if (workerLaneCount <= 0) {
    return allInvoker;
  }

  const workerHandlers = new Array<LaneHandler>(workerLaneCount);
  const workerContexts = new Array<CreateContext>(workerLaneCount);
  for (let source = 0, lane = 0; source < handlers.length; source += 1) {
    if (source === inlinerIndex) continue;
    workerHandlers[lane] = handlers[source]!;
    workerContexts[lane] = contexts[source]!;
    lane += 1;
  }
  const workerOnlyInvoker = selectStrategy(workerContexts, workerHandlers, strategy);

  let inFlight = 0;
  const releaseResolved = (value: unknown) => {
    inFlight -= 1;
    return value;
  };
  const releaseRejected = (error: unknown) => {
    inFlight -= 1;
    throw error;
  };

  return (args: any) => {
    inFlight += 1;

    const invoker = inFlight >= threshold ? allInvoker : workerOnlyInvoker;
    try {
      return invoker(args).then(releaseResolved, releaseRejected);
    } catch (error) {
      inFlight -= 1;
      throw error;
    }
  };
};

export function roundRobin(
  _contexts: readonly CreateContext[],
) {
  return (
    handlers: LaneHandler[],
  ) => {
    return (max: number) => {
      const top = Math.min(max, handlers.length);
      if (top <= 1) {
        return (args: any) => handlers[0]!(args);
      }
      let rrCursor = 0;
      return (
        args: any,
      ) => {
        const lane = rrCursor;
        rrCursor += 1;
        if (rrCursor === top) rrCursor = 0;
        return handlers[lane]!(args);
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
    handlers: LaneHandler[],
  ) => {
    return (max: number) => {
      const laneCount = Math.min(max, handlers.length);
      if (laneCount <= 1) {
        return (args: any) => handlers[0]!(args);
      }
      let rrCursor = 0;
      return (args: any) => {
        for (let lane = 0; lane < laneCount; lane += 1) {
          if (isSolved[lane]!()) {
            return handlers[lane]!(args);
          }
        }

        const fallback = rrCursor;
        rrCursor += 1;
        if (rrCursor === laneCount) rrCursor = 0;
        return handlers[fallback]!(args);
      };
    };
  };
}

export const randomLane = (_: readonly CreateContext[]) => {
  return (
    handlers: LaneHandler[],
  ) => {
    return (max: number) => {
      const laneCount = Math.min(max, handlers.length);
      if (laneCount <= 1) {
        return (args: any) => handlers[0]!(args);
      }
      return (args: any) => {
        const lane = (Math.random() * laneCount) | 0;
        return handlers[lane]!(args);
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
    handlers: LaneHandler[],
  ) => {
    return (max: number) => {
      const laneCount = Math.min(max, handlers.length);
      if (laneCount <= 1) {
        return (args: any) => handlers[0]!(args);
      }
      return (args: any) => {
        for (let lane = 0; lane < laneCount; lane += 1) {
          if (isSolved[lane]!()) {
            return handlers[lane]!(args);
          }
        }

        const fallback = (Math.random() * laneCount) | 0;
        return handlers[fallback]!(args);
      };
    };
  };
}
