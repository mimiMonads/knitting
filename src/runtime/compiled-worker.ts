import { getNodeBuiltinModule } from "../common/node-compat.ts";
import type { WorkerContext, WorkerSettings } from "../types.ts";
import {
  COMPILED_WORKER_JSON_PROTOCOL,
  inspectCompiledWorkerArtifact,
} from "./compiled-artifact.ts";
import { buildCompiledWorkerArtifact } from "./compiled-builder.ts";

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

const deno = (globalThis as typeof globalThis & { Deno?: DenoLike }).Deno;

const spawnNodeProcess = (artifact: string): NativeProcess | undefined => {
  const childProcess = getNodeBuiltinModule<ChildProcessModule>(
    "node:child_process",
  );
  if (childProcess === undefined) return undefined;

  const child = childProcess.spawn(artifact, [], {
    stdio: ["pipe", "pipe", "inherit"],
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

const spawnDenoProcess = (artifact: string): NativeProcess | undefined => {
  if (deno?.Command === undefined) return undefined;
  const child = new deno.Command(artifact, {
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
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

const spawnNativeProcess = (artifact: string): NativeProcess => {
  const process = spawnNodeProcess(artifact) ?? spawnDenoProcess(artifact);
  if (process === undefined) {
    throw new Error("Compiled workers require child-process support");
  }
  return process;
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

const assertJsonValue = (
  value: unknown,
  ancestors = new Set<object>(),
): void => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError("Compiled workers require lossless JSON numbers");
    }
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError(
      "Compiled workers only accept JSON-compatible values",
    );
  }
  if (ancestors.has(value)) {
    throw new TypeError("Compiled workers do not accept cyclic values");
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) {
        throw new TypeError("Compiled workers do not accept sparse arrays");
      }
      assertJsonValue(value[index], ancestors);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Compiled workers only accept plain objects");
    }
    for (const entry of Object.values(value as Record<string, unknown>)) {
      assertJsonValue(entry, ancestors);
    }
  }
  ancestors.delete(value);
};

const asciiJson = (value: unknown): string | undefined => {
  assertJsonValue(value);
  const serialized = JSON.stringify(value);
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
}: {
  list: string[];
  names: string[];
  workerOptions: WorkerSettings;
  hostDebug?: (message: string) => void;
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

  const native = spawnNativeProcess(inspection.artifact);
  const jsonProtocol = inspection.protocol === COMPILED_WORKER_JSON_PROTOCOL;
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
          pendingCall.resolve(JSON.parse(new TextDecoder().decode(bytes)));
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

  const call = ({ fnNumber }: { fnNumber: number }) => {
    const taskName = names[fnNumber]!;
    const targetIndex = taskIndices[fnNumber]!;
    return (rawArgs: Uint8Array): Promise<unknown> =>
      Promise.resolve(rawArgs as unknown).then((value) => {
        if (closedReason !== undefined || closing) {
          throw new Error(closedReason ?? "Compiled worker is shut down");
        }
        if (!jsonProtocol && typeof value !== "number") {
          throw new TypeError(
            "Compiled worker task " + taskName + " only accepts a number",
          );
        }

        let frame: Uint8Array;
        if (jsonProtocol) {
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
          if (payload.byteLength > 1024 * 1024) {
            throw new RangeError("Compiled worker input is too large");
          }
          frame = new Uint8Array(8 + payload.byteLength);
          const view = new DataView(frame.buffer);
          view.setInt32(0, targetIndex, true);
          view.setUint32(4, payload.byteLength, true);
          frame.set(payload, 8);
        } else {
          frame = new Uint8Array(16);
          const view = new DataView(frame.buffer);
          view.setInt32(0, targetIndex, true);
          view.setFloat64(8, value as number, true);
        }
        const result = new Promise<unknown>((resolve, reject) => {
          pending.push({ taskName, resolve, reject });
        });
        void queueWrite(frame);
        return result;
      });
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
          return;
        }
        const shutdown = new Uint8Array(jsonProtocol ? 8 : 16);
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
        }
      })();
      return closePromise;
    },
  };
};
