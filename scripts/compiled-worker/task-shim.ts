/** Worker-side replacement for the small part of Knitting task modules use. */

export type PorfforAbortSignal = {
  hasAborted: () => boolean;
  now: () => number;
};

export type PorfforTaskDefinition<A = unknown, B = unknown> = {
  f: (value: A, signal?: PorfforAbortSignal) => B;
  [key: string | symbol]: unknown;
};

const endpointSymbol = Symbol.for("task");

export const task = <A = unknown, B = unknown>(
  definition: PorfforTaskDefinition<A, B>,
): PorfforTaskDefinition<A, B> => {
  definition[endpointSymbol] = true;
  return definition;
};

// Host-only branches are folded away by Bun while producing the worker bundle.
export const isMain = false;
export const setModuleUrl = (_url: string | URL): void => {};

// Some modules keep their host pool declaration at top level and guard only
// the calls with `isMain`. Keep that declaration inert in the native bundle.
export const createPool = (_options: unknown) => (_tasks: unknown) => ({
  call: {},
  shutdown: () => Promise.resolve(),
  [Symbol.dispose]: () => {},
});
