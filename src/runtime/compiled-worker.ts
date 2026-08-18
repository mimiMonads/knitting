import { getNodeBuiltinModule, getNodeProcess } from "../common/node-compat.ts";
import {
  ProcessSharedBuffer,
  getDefaultProcessSharedBufferPrimitives,
  isProcessSharedBufferValue,
} from "../connections/process-shared-buffer.ts";
import { withResolvers } from "../common/with-resolvers.ts";
import {
  AbortSignalPoolExhausted,
  OneShotDeferred,
  signalAbortFactory,
  type SignalAbortStore,
} from "../shared/abortSignal.ts";
import type { WorkerContext, WorkerSettings } from "../types.ts";
import {
  COMPILED_WORKER_JSON_PROTOCOL,
  inspectCompiledWorkerArtifact,
} from "./compiled-artifact.ts";
import { buildCompiledWorkerArtifact } from "./compiled-builder.ts";

/** Matches the `abortSignalCapacity` default documented on pool options. */
const DEFAULT_ABORT_SLOTS = 258;
/** Both directions of the JSON protocols share this frame budget. */
const MAX_PAYLOAD_BYTES = 1024 * 1024;
/** Sentinel written to the slot field when a task is not abort-aware. */
const NO_ABORT_SLOT = -1;
/** Requests carry i32 task, i32 abort slot, then either a length or an f64. */
const JSON_HEADER_BYTES = 12;
const NUMBER_FRAME_BYTES = 16;
const NUMBER_ARGUMENT_OFFSET = 8;
const EMPTY_PAYLOAD = new Uint8Array(0);

type NodeWritable = {
  end: (callback?: () => void) => void;
  write: (data: Uint8Array) => boolean;
};

type NodeReadable = {
  on: (event: "data", listener: (data: Uint8Array) => void) => void;
};

type NodeChild = {
  stdin: NodeWritable;
  stdout: NodeReadable;
  kill: (signal?: string) => unknown;
  on: (
    event: "error" | "exit",
    listener: (...args: any[]) => void,
  ) => void;
};

type ChildProcessModule = {
  spawn: (
    command: string,
    args: string[],
    options: Record<string, unknown>,
  ) => NodeChild;
};

type DenoChild = {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  status: Promise<{ code: number }>;
  kill: (signal?: string) => void;
};

type DenoLike = {
  pid?: number;
  Command?: new (
    command: string,
    options: Record<string, unknown>,
  ) => { spawn: () => DenoChild };
};

type NativeProcess = {
  write: (data: Uint8Array) => Promise<void>;
  closeInput: () => Promise<void>;
  kill: () => void;
  exited: Promise<number>;
  onData: (listener: (data: Uint8Array) => void) => void;
  onError: (listener: (error: unknown) => void) => void;
};

type CompiledAbortChannel = SignalAbortStore & {
  /** Passed to the child so it can map the same bitmap. */
  environment: Record<string, string>;
  close: () => void;
};

const deno = (globalThis as typeof globalThis & { Deno?: DenoLike }).Deno;

const spawnNodeProcess = (
  artifact: string,
  environment?: Record<string, string>,
): NativeProcess | undefined => {
  const childProcess = getNodeBuiltinModule<ChildProcessModule>(
    "node:child_process",
  );
  if (childProcess === undefined) return undefined;

  const child = childProcess.spawn(artifact, [], {
    stdio: ["pipe", "pipe", "inherit"],
    env: environment === undefined
      ? undefined
      : { ...(getNodeProcess()?.env ?? {}), ...environment },
  });
  let dataListener: (data: Uint8Array) => void = () => {};
  let errorListener: (error: unknown) => void = () => {};
  child.stdout.on("data", (data) => dataListener(data));
  child.on("error", (error) => errorListener(error));
  const exited = new Promise<number>((resolve) => {
    child.on("exit", (code: number | null) => resolve(code ?? -1));
  });

  return {
    write: async (data) => {
      child.stdin.write(data);
    },
    closeInput: () =>
      new Promise<void>((resolve) => {
        child.stdin.end(resolve);
      }),
    kill: () => void child.kill("SIGTERM"),
    exited,
    onData: (listener) => void (dataListener = listener),
    onError: (listener) => void (errorListener = listener),
  };
};

const spawnDenoProcess = (
  artifact: string,
  environment?: Record<string, string>,
): NativeProcess | undefined => {
  if (deno?.Command === undefined) return undefined;
  const child = new deno.Command(artifact, {
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
    ...(environment === undefined ? {} : { env: environment }),
  }).spawn();
  const writer = child.stdin.getWriter();
  const reader = child.stdout.getReader();
  let dataListener: (data: Uint8Array) => void = () => {};
  let errorListener: (error: unknown) => void = () => {};
  void (async () => {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        dataListener(next.value);
      }
    } catch (error) {
      errorListener(error);
    }
  })();

  return {
    write: async (data) => {
      await writer.write(data);
    },
    closeInput: async () => {
      await writer.close();
    },
    kill: () => child.kill("SIGTERM"),
    exited: child.status.then((status) => status.code),
    onData: (listener) => void (dataListener = listener),
    onError: (listener) => void (errorListener = listener),
  };
};

const spawnNativeProcess = (
  artifact: string,
  environment?: Record<string, string>,
): NativeProcess => {
  const process = spawnNodeProcess(artifact, environment) ??
    spawnDenoProcess(artifact, environment);
  if (process === undefined) {
    throw new Error("Compiled workers require child-process support");
  }
  return process;
};

const compiledAbortName = (): string => {
  const pid = getNodeProcess()?.pid ?? deno?.pid ?? 0;
  const nonce = Math.floor(Math.random() * 0x1000000).toString(36);
  return `knit_abort_${Math.abs(pid).toString(36)}_${nonce}`.slice(0, 30);
};

/**
 * Host half of the abort bitmap. Slot bookkeeping is the same allocator every
 * other lane uses; only the backing store differs, because a compiled child is
 * a separate process and reads the words through named POSIX shared memory.
 */
export const createCompiledAbortChannel = (
  requestedMax = DEFAULT_ABORT_SLOTS,
): CompiledAbortChannel => {
  const max = Number.isFinite(requestedMax) && requestedMax > 0
    ? Math.floor(requestedMax)
    : DEFAULT_ABORT_SLOTS;
  const byteLength = Math.max(1, Math.ceil(max / 32)) *
    Uint32Array.BYTES_PER_ELEMENT;
  const primitives = getDefaultProcessSharedBufferPrimitives();
  const name = compiledAbortName();
  const shared = ProcessSharedBuffer.create(
    { mode: "create", name, size: byteLength },
    primitives,
  );
  let closed = false;

  return {
    ...signalAbortFactory({
      sab: shared.subbuffer(0, byteLength).getRegion(primitives),
      maxSignals: max,
    }),
    environment: {
      KNITTING_COMPILED_ABORT_SHM: name.startsWith("/") ? name : `/${name}`,
      KNITTING_COMPILED_ABORT_BYTES: String(byteLength),
    },
    close: () => {
      if (closed) return;
      closed = true;
      shared.descriptor.mapping?.close?.();
      primitives.unlinkSharedMemory?.(name);
    },
  };
};

type PendingCall = {
  taskName: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

type CompiledWorkerContext = WorkerContext & {
  dispatcherCheck?: never;
  laneWake?: never;
  bindSend?: never;
};

// One resolved WorkerSettings object is shared by every lane in a pool. This
// prevents `build: "always"` from recompiling once per lane.
const forcedBuildPools = new WeakSet<WorkerSettings>();

const responseError = (status: number, taskName: string): Error => {
  if (status === 1) {
    return new RangeError("Unknown compiled task: " + taskName);
  }
  if (status === 2) {
    return new TypeError(
      "Compiled task " + taskName + " returned an unsupported value",
    );
  }
  if (status === 3) return new Error("Compiled task " + taskName + " threw");
  if (status === 4) {
    return new RangeError("Compiled task " + taskName + " result is too large");
  }
  return new Error("Compiled worker returned unknown status " + status);
};

/** Reserved wire key: a plain object carrying it would be ambiguous. */
const COMPILED_VALUE_TAG = "$knitting";
const ARRAY_BUFFER_TAG = "array-buffer";
const DATA_VIEW_TAG = "data-view";

/** Wire tag to view constructor, read by both directions of the codec. */
const TYPED_ARRAYS: Record<string, {
  new (buffer: ArrayBuffer): ArrayBufferView;
  readonly BYTES_PER_ELEMENT: number;
}> = {
  u8: Uint8Array,
  u8c: Uint8ClampedArray,
  i8: Int8Array,
  u16: Uint16Array,
  i16: Int16Array,
  u32: Uint32Array,
  i32: Int32Array,
  f32: Float32Array,
  f64: Float64Array,
};

const typedArrayTags = new Map<unknown, string>(
  Object.entries(TYPED_ARRAYS).map(([tag, view]) => [view, tag]),
);

const binaryTagOf = (value: object): string | undefined =>
  value instanceof ArrayBuffer
    ? ARRAY_BUFFER_TAG
    : value instanceof DataView
    ? DATA_VIEW_TAG
    : typedArrayTags.get(value.constructor);

const rawBytes = (value: ArrayBuffer | ArrayBufferView): Uint8Array =>
  value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

// String.fromCharCode is applied in chunks so a megabyte payload cannot
// overflow the argument list.
const BASE64_CHUNK = 0x8000;

const toBase64 = (bytes: Uint8Array): string => {
  let latin1 = "";
  for (let at = 0; at < bytes.length; at += BASE64_CHUNK) {
    latin1 += String.fromCharCode(...bytes.subarray(at, at + BASE64_CHUNK));
  }
  return btoa(latin1);
};

const fromBase64 = (text: unknown): Uint8Array => {
  if (typeof text !== "string") {
    throw new TypeError("Compiled binary value is not base64 text");
  }
  return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
};

/**
 * Validates a value and rewrites it for the wire: buffers and views travel as
 * tagged base64, and a named ProcessSharedBuffer travels as a mapping request
 * the child fulfils by mapping the same shared memory itself.
 */
const encodeCompiledValue = (
  value: unknown,
  ancestors = new Set<object>(),
): unknown => {
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError("Compiled workers require lossless JSON numbers");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError("Compiled workers only accept JSON-compatible values");
  }
  if (ancestors.has(value)) {
    throw new TypeError("Compiled workers do not accept cyclic values");
  }

  if (isProcessSharedBufferValue(value)) {
    const name = value.descriptor.name;
    if (name === undefined) {
      throw new TypeError(
        "Compiled workers require a named ProcessSharedBuffer",
      );
    }
    if (value.size > MAX_PAYLOAD_BYTES) {
      throw new RangeError(
        "Compiled ProcessSharedBuffer values are limited to 1 MiB",
      );
    }
    return {
      [COMPILED_VALUE_TAG]: "process-shared",
      name: name.startsWith("/") ? name : `/${name}`,
      size: value.size,
      offset: value.byteOffset,
      length: value.byteLength,
    };
  }

  const tag = binaryTagOf(value);
  if (tag !== undefined) {
    return {
      [COMPILED_VALUE_TAG]: tag,
      data: toBase64(rawBytes(value as ArrayBuffer | ArrayBufferView)),
    };
  }
  if (ArrayBuffer.isView(value)) {
    throw new TypeError("Compiled workers do not support BigInt typed arrays");
  }

  ancestors.add(value);
  let encoded: unknown;
  if (Array.isArray(value)) {
    const entries: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) {
        throw new TypeError("Compiled workers do not accept sparse arrays");
      }
      entries.push(encodeCompiledValue(value[index], ancestors));
    }
    encoded = entries;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Compiled workers only accept plain objects");
    }
    const record: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === COMPILED_VALUE_TAG) {
        throw new TypeError(
          "Compiled workers reserve the " + COMPILED_VALUE_TAG + " key",
        );
      }
      record[key] = encodeCompiledValue(entry, ancestors);
    }
    encoded = record;
  }
  ancestors.delete(value);
  return encoded;
};

const decodeCompiledValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(decodeCompiledValue);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const tag = record[COMPILED_VALUE_TAG];
  if (typeof tag === "string") {
    const bytes = fromBase64(record.data);
    if (tag === ARRAY_BUFFER_TAG) return bytes.buffer;
    if (tag === DATA_VIEW_TAG) return new DataView(bytes.buffer);
    const view = TYPED_ARRAYS[tag];
    if (view === undefined) {
      throw new TypeError("Compiled worker returned an unknown binary value");
    }
    if (bytes.byteLength % view.BYTES_PER_ELEMENT !== 0) {
      throw new TypeError("Compiled worker returned misaligned binary data");
    }
    return new view(bytes.buffer as ArrayBuffer);
  }
  const decoded: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    decoded[key] = decodeCompiledValue(entry);
  }
  return decoded;
};

const asciiJson = (value: unknown): string | undefined => {
  const wireValue = encodeCompiledValue(value);
  const serialized = JSON.stringify(wireValue);
  if (serialized !== undefined) {
    for (let index = 0; index < serialized.length; index++) {
      const unit = serialized.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdfff) {
        throw new TypeError(
          "Compiled workers do not yet support non-BMP Unicode",
        );
      }
    }
  }
  return serialized?.replace(/[^\x00-\x7f]/g, (character) =>
    "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0")
  );
};

export const spawnCompiledWorkerContext = ({
  list,
  names,
  workerOptions,
  hostDebug,
  abortSignalCapacity,
  usesAbortSignal,
}: {
  list: string[];
  names: string[];
  workerOptions: WorkerSettings;
  hostDebug?: (message: string) => void;
  abortSignalCapacity?: number;
  usesAbortSignal?: boolean;
}): CompiledWorkerContext => {
  if (list.length !== 1) {
    throw new Error("A compiled worker pool must use one task module");
  }
  let inspection = inspectCompiledWorkerArtifact({
    source: list[0]!,
    options: workerOptions.compiled,
    requiredTasks: names,
  });
  const forceBuild = workerOptions.compiled?.build === "always" &&
    !forcedBuildPools.has(workerOptions);
  if (forceBuild) forcedBuildPools.add(workerOptions);
  if (
    forceBuild ||
    (!inspection.compiled && workerOptions.compiled?.build !== false)
  ) {
    try {
      buildCompiledWorkerArtifact({
        inspection,
        source: list[0]!,
        tasks: names,
        options: workerOptions.compiled,
      });
    } catch (error) {
      const message = String(
        (error as { message?: unknown })?.message ?? error,
      );
      throw new Error(
        "Compiled worker could not be built: " + message +
          ". Initial validation: " + (inspection.reason ?? "unknown reason"),
      );
    }
    inspection = inspectCompiledWorkerArtifact({
      source: list[0]!,
      options: workerOptions.compiled,
      requiredTasks: names,
    });
  }
  if (!inspection.compiled || inspection.taskEntries === undefined) {
    throw new Error(
      "Compiled worker is unavailable: " +
        (inspection.reason ?? "unknown reason") + ". Expected " +
        inspection.artifact + " with " + inspection.manifest,
    );
  }

  const artifactIndex = new Map(
    inspection.taskEntries.map((task) => [task.exportName, task.index]),
  );
  const taskIndices = names.map((name) => artifactIndex.get(name)!);
  hostDebug?.(
    "compiled artifact=" + inspection.artifact +
      " compiler=" + inspection.compiler,
  );

  const abortChannel = usesAbortSignal === true
    ? createCompiledAbortChannel(abortSignalCapacity)
    : undefined;
  let native: NativeProcess;
  try {
    native = spawnNativeProcess(inspection.artifact, abortChannel?.environment);
  } catch (error) {
    abortChannel?.close();
    throw error;
  }
  const jsonProtocol = inspection.protocol === COMPILED_WORKER_JSON_PROTOCOL;
  const requestHeaderBytes = jsonProtocol
    ? JSON_HEADER_BYTES
    : NUMBER_FRAME_BYTES;
  const pending: PendingCall[] = [];
  let responseBytes = new Uint8Array(0);
  let closing = false;
  let closedReason: string | undefined;
  let writeTail = Promise.resolve();

  const rejectPending = (reason: unknown): void => {
    while (pending.length > 0) pending.shift()!.reject(reason);
  };
  const fail = (reason: unknown): void => {
    if (closedReason !== undefined) return;
    closedReason = String((reason as { message?: unknown })?.message ?? reason);
    rejectPending(new Error(closedReason));
  };

  native.onError(fail);
  native.onData((chunk) => {
    const merged = new Uint8Array(responseBytes.byteLength + chunk.byteLength);
    merged.set(responseBytes);
    merged.set(chunk, responseBytes.byteLength);
    let offset = 0;
    while (true) {
      const headerLength = jsonProtocol ? 8 : 16;
      if (offset + headerLength > merged.byteLength) break;
      const header = new DataView(
        merged.buffer,
        merged.byteOffset + offset,
        headerLength,
      );
      const payloadLength = jsonProtocol ? header.getUint32(4, true) : 8;
      if (payloadLength > 64 * 1024 * 1024) {
        fail("Compiled worker returned an oversized response");
        native.kill();
        return;
      }
      const frameLength = jsonProtocol ? headerLength + payloadLength : 16;
      if (offset + frameLength > merged.byteLength) break;
      const pendingCall = pending.shift();
      if (pendingCall === undefined) {
        fail("Compiled worker returned an unexpected response");
        native.kill();
        return;
      }
      const status = header.getInt32(0, true);
      if (status !== 0) {
        pendingCall.reject(responseError(status, pendingCall.taskName));
      } else if (jsonProtocol) {
        try {
          const bytes = merged.subarray(offset + 8, offset + frameLength);
          const decoded = JSON.parse(new TextDecoder().decode(bytes));
          pendingCall.resolve(decodeCompiledValue(decoded));
        } catch (error) {
          pendingCall.reject(
            new Error("Compiled worker returned invalid JSON", { cause: error }),
          );
        }
      } else {
        pendingCall.resolve(header.getFloat64(8, true));
      }
      offset += frameLength;
    }
    responseBytes = merged.slice(offset);
  });
  void native.exited.then((code) => {
    if (!closing || code !== 0) {
      fail("Compiled worker exited with code " + code);
    }
  });

  const queueWrite = (frame: Uint8Array): Promise<void> => {
    writeTail = writeTail.then(() => native.write(frame));
    void writeTail.catch(fail);
    return writeTail;
  };

  /**
   * Everything that can reject a call lives here, so it all runs before an
   * abort slot is claimed and a claimed slot can never leak.
   */
  const encodePayload = (taskName: string, value: unknown): Uint8Array => {
    if (!jsonProtocol) {
      if (typeof value !== "number") {
        throw new TypeError(
          "Compiled worker task " + taskName + " only accepts a number",
        );
      }
      return EMPTY_PAYLOAD;
    }
    // Porffor's JSON parser is reliable with escaped UTF-16 code units;
    // keeping request bytes ASCII also avoids depending on its internal
    // string representation for supplementary Unicode code points.
    const serialized = asciiJson(value);
    if (serialized === undefined) {
      throw new TypeError(
        "Compiled worker task " + taskName +
          " only accepts JSON-compatible values",
      );
    }
    const payload = new TextEncoder().encode(serialized);
    if (payload.byteLength > MAX_PAYLOAD_BYTES) {
      throw new RangeError("Compiled worker input is too large");
    }
    return payload;
  };

  const call = ({
    fnNumber,
    abortSignal,
  }: {
    fnNumber: number;
    abortSignal?: unknown;
  }) => {
    const taskName = names[fnNumber]!;
    const targetIndex = taskIndices[fnNumber]!;
    const usesSignal = abortSignal !== undefined;
    return (rawArgs: Uint8Array): Promise<unknown> => {
      const deferred = withResolvers<unknown>();
      const send = (value: unknown): void => {
        if (closedReason !== undefined || closing) {
          deferred.reject(
            new Error(closedReason ?? "Compiled worker is shut down"),
          );
          return;
        }
        if (usesSignal && abortChannel === undefined) {
          deferred.reject(
            new Error("Compiled worker abort channel is unavailable"),
          );
          return;
        }

        let payload: Uint8Array;
        try {
          payload = encodePayload(taskName, value);
        } catch (error) {
          deferred.reject(error);
          return;
        }

        const signal = usesSignal ? abortChannel!.getSignal() : NO_ABORT_SLOT;
        if (usesSignal && signal === abortChannel!.closeNow) {
          deferred.reject(AbortSignalPoolExhausted);
          return;
        }
        if (usesSignal) {
          new OneShotDeferred(
            deferred,
            () => abortChannel!.resetSignal(signal),
            () => abortChannel!.setSignal(signal),
          );
        }

        const frame = new Uint8Array(requestHeaderBytes + payload.byteLength);
        const header = new DataView(frame.buffer);
        header.setInt32(0, targetIndex, true);
        header.setInt32(4, signal, true);
        if (jsonProtocol) {
          header.setUint32(8, payload.byteLength, true);
          frame.set(payload, requestHeaderBytes);
        } else {
          header.setFloat64(NUMBER_ARGUMENT_OFFSET, value as number, true);
        }

        pending.push({
          taskName,
          resolve: deferred.resolve,
          reject: deferred.reject,
        });
        void queueWrite(frame);
      };

      if (rawArgs instanceof Promise) {
        void rawArgs.then(send, deferred.reject);
      } else {
        send(rawArgs as unknown);
      }
      return deferred.promise;
    };
  };

  let closePromise: Promise<void> | undefined;
  return {
    txIdle: () => pending.length === 0,
    call,
    kills: () => {
      if (closePromise !== undefined) return closePromise;
      closing = true;
      const hadPendingCalls = pending.length > 0;
      rejectPending(new Error("Compiled worker is shutting down"));
      closePromise = (async () => {
        if (hadPendingCalls) {
          native.kill();
          await native.exited;
          closedReason ??= "Compiled worker is shut down";
          abortChannel?.close();
          return;
        }
        const shutdown = new Uint8Array(requestHeaderBytes);
        new DataView(shutdown.buffer).setInt32(0, -1, true);
        try {
          await queueWrite(shutdown);
          await native.closeInput();
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          const exited = await Promise.race([
            native.exited.then(() => true),
            new Promise<false>((resolve) =>
              timeoutId = setTimeout(() => resolve(false), 1000)
            ),
          ]);
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          if (!exited) native.kill();
        } finally {
          closedReason ??= "Compiled worker is shut down";
          abortChannel?.close();
        }
      })();
      return closePromise;
    },
  };
};
