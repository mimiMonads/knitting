import test from "./_runner.ts";
import { createPool, Envelope, importTask, task } from "../knitting.ts";
import type { ProcessSharedBuffer } from "../shared-memory.ts";
import type { BufferReference } from "../unsafe.ts";
import { sharedBytes } from "../unsafe.ts";

const runtimeProcess = (globalThis as typeof globalThis & {
  process?: {
    platform?: string;
    versions?: { bun?: string; node?: string };
  };
}).process;
const isPlainNodeWindows = runtimeProcess?.platform === "win32" &&
  typeof runtimeProcess.versions?.node === "string" &&
  runtimeProcess.versions.bun === undefined &&
  (globalThis as typeof globalThis & { Deno?: unknown }).Deno === undefined;

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true
  : false;

type ResizeInput = {
  width: number;
  height: number;
};

const square = (value: number) => value * value;

const greet = (name: string) => `hello ${name}`;

const add = task<[number, number], number>({
  f: ([a, b]) => a + b,
});

const pixels = task<ResizeInput, number>({
  f: ({ width, height }) => width * height,
});

const maybeSlow = task<string, string>({
  timeout: { time: 500, default: "timed out" },
  f: async (value) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return value.toUpperCase();
  },
});

const numericTimeoutTask = task({
  timeout: 100,
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

const countUntilStopped = task({
  abortSignal: { hasAborted: true },
  f: async (limit: number, signal) => {
    for (let index = 0; index < limit; index += 1) {
      if (signal.hasAborted()) return index;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    return limit;
  },
});

const abortMarkerTask = task({
  abortSignal: true,
  f: async (value: string) => value.toUpperCase(),
});

const importedAdd = importTask<[number, number], number>({
  href: "./fixtures/worker-tasks.ts",
  name: "add",
});

const readFirstCell = task<ProcessSharedBuffer, number>({
  f: (buffer) => Atomics.load(buffer.view(Int32Array), 0),
});

const invert = task<BufferReference, number>({
  f: (ref) => ref.toUint8Array().length,
});

const processImage = task<
  Envelope<{ format: string }>,
  Envelope<{ width: number; height: number }>
>({
  f: (envelope) => {
    const pixels = new Uint8Array(envelope.payload);
    return new Envelope({ width: 800, height: 600 }, pixels.buffer);
  },
});

const echoEnvelopeShared = task<
  Envelope<{ tag: string }, SharedArrayBuffer>,
  Envelope<{ tag: string }, SharedArrayBuffer>
>({
  f: (envelope) => envelope,
});

const echoEnvelopeRef = task<
  Envelope<{ op: string }, BufferReference>,
  Envelope<{ op: string }, BufferReference>
>({
  f: (envelope) => envelope,
});

const assertReadmeTypes = () => {
  const quickStartPool = createPool({ threads: 2 })({
    square,
    greet,
  });

  quickStartPool.call.square(2);
  quickStartPool.call.greet("knitting");
  // @ts-expect-error README square task takes a number.
  quickStartPool.call.square("2");
  // @ts-expect-error README greet task takes a string.
  quickStartPool.call.greet(42);

  type _quickStartSquareReturn = Assert<
    Equal<Awaited<ReturnType<typeof quickStartPool.call.square>>, number>
  >;
  type _quickStartGreetReturn = Assert<
    Equal<Awaited<ReturnType<typeof quickStartPool.call.greet>>, string>
  >;

  const addPool = createPool({ threads: 4 })({ add });

  addPool.call.add([1, 2]);
  addPool.call.add(Promise.resolve([1, 2] as [number, number]));
  // @ts-expect-error README tuple task takes one tuple input.
  addPool.call.add(1, 2);

  type _addReturn = Assert<
    Equal<Awaited<ReturnType<typeof addPool.call.add>>, number>
  >;

  const pixelsPool = createPool({})({ pixels });

  pixelsPool.call.pixels({ width: 2, height: 3 });
  // @ts-expect-error README object input requires width and height.
  pixelsPool.call.pixels({ width: 2 });

  type _pixelsReturn = Assert<
    Equal<Awaited<ReturnType<typeof pixelsPool.call.pixels>>, number>
  >;

  const timeoutPool = createPool({ worker: { hardTimeoutMs: 1_000 } })({
    maybeSlow,
    numericTimeoutTask,
    timeoutErrorTask,
  });

  timeoutPool.call.maybeSlow("hello");
  timeoutPool.call.numericTimeoutTask("hello");
  timeoutPool.call.timeoutErrorTask("hello");
  // @ts-expect-error timeout metadata should not change the host input shape.
  timeoutPool.call.maybeSlow();

  type _maybeSlowReturn = Assert<
    Equal<Awaited<ReturnType<typeof timeoutPool.call.maybeSlow>>, string>
  >;
  type _numericTimeoutReturn = Assert<
    Equal<
      Awaited<ReturnType<typeof timeoutPool.call.numericTimeoutTask>>,
      string
    >
  >;
  type _timeoutErrorReturn = Assert<
    Equal<Awaited<ReturnType<typeof timeoutPool.call.timeoutErrorTask>>, string>
  >;

  const abortPool = createPool({ abortSignalCapacity: 8 })({
    countUntilStopped,
    abortMarkerTask,
  });

  abortPool.call.countUntilStopped(10);
  abortPool.call.countUntilStopped(Promise.resolve(10));
  // @ts-expect-error README abort-aware task takes one number input.
  abortPool.call.countUntilStopped("10");

  abortPool.call.abortMarkerTask("hello");
  abortPool.call.abortMarkerTask(Promise.resolve("hello"));
  // @ts-expect-error abortSignal true keeps the host input shape.
  abortPool.call.abortMarkerTask();

  type _abortTaskReturn = Assert<
    Equal<Awaited<ReturnType<typeof abortPool.call.countUntilStopped>>, number>
  >;
  type _abortMarkerReturn = Assert<
    Equal<Awaited<ReturnType<typeof abortPool.call.abortMarkerTask>>, string>
  >;

  const importPool = createPool({ threads: 2 })({
    importedAdd,
  });

  importPool.call.importedAdd([2, 3]);
  importPool.call.importedAdd(Promise.resolve([2, 3] as [number, number]));
  // @ts-expect-error README importTask tuple input must be one tuple.
  importPool.call.importedAdd(2, 3);

  type _importTupleReturn = Assert<
    Equal<Awaited<ReturnType<typeof importPool.call.importedAdd>>, number>
  >;

  const double = task<number, number>({
    f: (value) => value * 2,
  }).createPool({ threads: 2 });

  double.call(21);
  // @ts-expect-error README single-task shorthand preserves input type.
  double.call("21");

  type _singleTaskReturn = Assert<
    Equal<Awaited<ReturnType<typeof double.call>>, number>
  >;

  const sharedPool = createPool({ threads: 1 })({ readFirstCell });
  const shared = null as unknown as ProcessSharedBuffer;

  sharedPool.call.readFirstCell(shared);
  // @ts-expect-error README shared-memory task expects ProcessSharedBuffer.
  sharedPool.call.readFirstCell(new ArrayBuffer(4));

  type _sharedReturn = Assert<
    Equal<Awaited<ReturnType<typeof sharedPool.call.readFirstCell>>, number>
  >;

  const bufferRefPool = createPool({ threads: 1 })({ invert });
  const bufferRef = null as unknown as BufferReference;

  bufferRefPool.call.invert(bufferRef);
  // @ts-expect-error README BufferReference task expects a BufferReference.
  bufferRefPool.call.invert(new ArrayBuffer(4));

  type _bufferRefReturn = Assert<
    Equal<Awaited<ReturnType<typeof bufferRefPool.call.invert>>, number>
  >;

  const envelopePool = createPool({ threads: 2 })({ processImage });
  const buf = new ArrayBuffer(1024);

  envelopePool.call.processImage(new Envelope({ format: "png" }, buf));
  // @ts-expect-error README Envelope task expects an Envelope, not a plain object.
  envelopePool.call.processImage({ format: "png" });

  type _envelopeReturn = Assert<
    Equal<
      Awaited<ReturnType<typeof envelopePool.call.processImage>>,
      Envelope<{ width: number; height: number }>
    >
  >;

  const envelopeSharedPool = createPool({ threads: 1 })({ echoEnvelopeShared });
  envelopeSharedPool.call.echoEnvelopeShared(
    new Envelope({ tag: "img" }, new SharedArrayBuffer(8)),
  );
  type _envelopeSharedReturn = Assert<
    Equal<
      Awaited<ReturnType<typeof envelopeSharedPool.call.echoEnvelopeShared>>,
      Envelope<{ tag: string }, SharedArrayBuffer>
    >
  >;

  const envelopeRefPool = createPool({ threads: 1 })({ echoEnvelopeRef });
  const envelopeRefBody = null as unknown as BufferReference;
  envelopeRefPool.call.echoEnvelopeRef(
    new Envelope({ op: "invert" }, envelopeRefBody),
  );
  type _envelopeRefReturn = Assert<
    Equal<
      Awaited<ReturnType<typeof envelopeRefPool.call.echoEnvelopeRef>>,
      Envelope<{ op: string }, BufferReference>
    >
  >;

  const configuredPool = createPool({
    threads: 4,
    balancer: "firstIdle",
    payload: {
      payloadMaxByteLength: 64 * 1024 * 1024,
      maxPayloadBytes: 8 * 1024 * 1024,
    },
    worker: {
      bootstrap: {
        href: "./fixtures/bootstrap_setup.ts",
        name: "setup",
        data: { value: "ready" },
      },
      runtime: "process",
      processRuntime: "deno",
      hardTimeoutMs: 1_000,
      resolveAfterFinishingAll: true,
    },
    permission: {
      mode: "strict",
      allowImport: true,
      read: ["./data"],
      write: ["./out"],
      net: ["api.example.com"],
      env: { allow: ["NODE_ENV"] },
      console: true,
    },
  })({ add });

  configuredPool.call.add([1, 2]);

  createPool({
    // @ts-expect-error README balancer names are camelCase API strings.
    balancer: "least-busy",
  })({ add });

  // README: zero-copy returns with `sharedBytes`.
  const render = task<number, Uint8Array>({
    f: (size) => {
      const out = sharedBytes(size);
      for (let i = 0; i < out.length; i++) out[i] = i & 0xff;
      return out;
    },
  });

  const renderPool = createPool({
    threads: 4,
    unsafe: { SharedBytesReclaim: "gc" },
  })({ render });

  type RenderReturn = Awaited<ReturnType<typeof renderPool.call.render>>;
  type _RenderIsBytes = Assert<Equal<RenderReturn, Uint8Array>>;

  createPool({
    threads: 1,
    unsafe: { SharedBytesReclaim: "ring", SharedBytesRingSlabs: 128 },
  })({ render });

  createPool({
    // @ts-expect-error README documents only "ring" and "gc".
    unsafe: { SharedBytesReclaim: "refcount" },
  })({ render });

  // README: `unsafe.SharedBytes: false` turns the pointer path off entirely.
  createPool({ threads: 4, unsafe: { SharedBytes: false } })({ render });

  // README: the upgrade threshold is separately tunable from the slab one.
  createPool({
    threads: 1,
    unsafe: { SharedBytesUpgradeMinBytes: 512 * 1024 },
  })({ render });

  createPool({
    // @ts-expect-error the off switch is a boolean, not a mode string.
    unsafe: { SharedBytes: "off" },
  })({ render });
};

void assertReadmeTypes;

// Tracking the Windows Node CI hang in
// https://github.com/mimiMonads/knitting/issues/44.
test("README examples type-check", {
  skip: isPlainNodeWindows
    ? "temporarily disabled on Windows Node; see #44"
    : false,
}, () => {});
