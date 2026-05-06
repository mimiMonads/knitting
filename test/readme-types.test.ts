import test from "node:test";
import { createPool, importTask, task } from "../knitting.ts";

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true
  : false;

const hello = task({
  f: async () => "hello",
});

const world = task({
  f: async () => "world",
});

const slowTask = task({
  abortSignal: { hasAborted: true },
  f: async (value: string, signal) => {
    if (signal.hasAborted()) return "aborted";
    return value.toUpperCase();
  },
});

const abortMarkerTask = task({
  abortSignal: true,
  f: async (value: string) => value.toUpperCase(),
});

const numericTimeoutTask = task({
  timeout: 100,
  f: async (value: string) => value.toUpperCase(),
});

const timeoutDefaultTask = task({
  timeout: { time: 100, maybe: true, default: "timeout" },
  f: async (value: string) => value.toUpperCase(),
});

const timeoutErrorTask = task({
  timeout: { time: 100, error: new Error("timeout") },
  f: async (value: string) => value.toUpperCase(),
});

task({
  // @ts-expect-error timeout must be a number or timeout options object.
  timeout: "100",
  f: async (value: string) => value.toUpperCase(),
});

task({
  // @ts-expect-error timeout options require a numeric time field.
  timeout: { maybe: true },
  f: async (value: string) => value.toUpperCase(),
});

const addFromWeb = importTask<[number, number], number>({
  href: "https://knittingdocs.netlify.app/example-task.mjs",
  name: "add",
});

const wordStatsFromWeb = importTask<
  { text: string },
  { words: number; chars: number }
>({
  href: "https://knittingdocs.netlify.app/example-task.mjs",
  name: "wordStats",
});

const add = task<[number, number], number>({
  f: async ([a, b]) => a + b,
});

const assertReadmeTypes = () => {
  const quickStartPool = createPool({ threads: 2 })({
    hello,
    world,
  });

  quickStartPool.call.hello();
  quickStartPool.call.world();
  // @ts-expect-error README zero-argument tasks should not accept host input.
  quickStartPool.call.hello("extra");

  type _quickStartHelloReturn = Assert<
    Equal<Awaited<ReturnType<typeof quickStartPool.call.hello>>, string>
  >;

  const abortPool = createPool({ threads: 1 })({
    slowTask,
  });

  abortPool.call.slowTask("hello");
  abortPool.call.slowTask(Promise.resolve("hello"));
  // @ts-expect-error README abort-aware task takes one string input.
  abortPool.call.slowTask(1);

  type _abortTaskReturn = Assert<
    Equal<Awaited<ReturnType<typeof abortPool.call.slowTask>>, string>
  >;

  const abortMarkerPool = createPool({ abortSignalCapacity: 8 })({
    abortMarkerTask,
  });

  abortMarkerPool.call.abortMarkerTask("hello");
  abortMarkerPool.call.abortMarkerTask(Promise.resolve("hello"));
  // @ts-expect-error abortSignal true keeps the host input shape.
  abortMarkerPool.call.abortMarkerTask();

  type _abortMarkerReturn = Assert<
    Equal<Awaited<ReturnType<typeof abortMarkerPool.call.abortMarkerTask>>, string>
  >;

  const timeoutPool = createPool({ worker: { hardTimeoutMs: 1_000 } })({
    numericTimeoutTask,
    timeoutDefaultTask,
    timeoutErrorTask,
  });

  timeoutPool.call.numericTimeoutTask("hello");
  timeoutPool.call.timeoutDefaultTask("hello");
  timeoutPool.call.timeoutErrorTask("hello");
  // @ts-expect-error timeout metadata should not change the host input shape.
  timeoutPool.call.numericTimeoutTask();

  type _numericTimeoutReturn = Assert<
    Equal<Awaited<ReturnType<typeof timeoutPool.call.numericTimeoutTask>>, string>
  >;
  type _timeoutDefaultReturn = Assert<
    Equal<Awaited<ReturnType<typeof timeoutPool.call.timeoutDefaultTask>>, string>
  >;
  type _timeoutErrorReturn = Assert<
    Equal<Awaited<ReturnType<typeof timeoutPool.call.timeoutErrorTask>>, string>
  >;

  const importPool = createPool({ threads: 2 })({
    addFromWeb,
    wordStatsFromWeb,
  });

  importPool.call.addFromWeb([8, 5]);
  importPool.call.addFromWeb(Promise.resolve([8, 5] as [number, number]));
  // @ts-expect-error README importTask tuple input must be a tuple.
  importPool.call.addFromWeb(8, 5);

  type _importTupleReturn = Assert<
    Equal<Awaited<ReturnType<typeof importPool.call.addFromWeb>>, number>
  >;

  importPool.call.wordStatsFromWeb({ text: "hello from remote tasks" });
  importPool.call.wordStatsFromWeb(Promise.resolve({ text: "hello from remote tasks" }));
  // @ts-expect-error README wordStats input requires a text property.
  importPool.call.wordStatsFromWeb({});

  type _importObjectReturn = Assert<
    Equal<
      Awaited<ReturnType<typeof importPool.call.wordStatsFromWeb>>,
      { words: number; chars: number }
    >
  >;

  const addPool = createPool({})({ add });

  addPool.call.add([1, 2]);
  addPool.call.add(Promise.resolve([1, 2] as [number, number]));
  // @ts-expect-error README explicit tuple task takes one tuple input.
  addPool.call.add(1, 2);

  type _explicitTupleReturn = Assert<
    Equal<Awaited<ReturnType<typeof addPool.call.add>>, number>
  >;
};

void assertReadmeTypes;

test("README examples type-check", () => {});
