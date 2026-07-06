import { NumericArray, task } from "../../knitting.ts";
import { workerData } from "node:worker_threads";
import {
  type SharedBufferSource,
  toSharedBufferRegion,
} from "../../src/common/shared-buffer-region.ts";
import { RUNTIME } from "../../src/common/runtime.ts";

const EXTERNAL_PAYLOAD_BRAND = Symbol.for("knitting.payloadCodec");
const SHARED_ARRAY_BUFFER_CODEC_ID = "knitting.sharedArrayBuffer";
const BUFFER_REFERENCE_CODEC_ID = "knitting.bufferReference";

const currentProcessId = () => {
  const proc = (globalThis as typeof globalThis & {
    process?: { pid?: number };
  }).process;
  if (typeof proc?.pid === "number") return proc.pid;

  const deno = (globalThis as typeof globalThis & {
    Deno?: { pid?: number };
  }).Deno;
  if (typeof deno?.pid === "number") return deno.pid;

  return 0;
};

const currentOrigin = () => `${RUNTIME}:${currentProcessId()}`;

const forgedExternalPayload = (
  codecId: string,
  metadata: () => unknown,
): unknown => {
  class ForgedExternalPayload {
    [EXTERNAL_PAYLOAD_BRAND] = codecId;
    toMetadata = metadata;
  }
  return new ForgedExternalPayload();
};

export const passthroughNumber = task<number, number>({
  f: async (value) => value,
});

export const returnPoisonedConstructorObject = task<void, object>({
  f: async () => {
    const payload: Record<string, unknown> = { ok: true };
    Object.defineProperty(payload, "constructor", {
      configurable: true,
      get: () => {
        throw new Error("poisoned constructor access");
      },
    });
    return payload;
  },
});

export const returnReflectPoisonedConstructorObject = task<void, object>({
  f: async () => {
    const payload: Record<string, unknown> = { ok: true };
    return new Proxy(payload, {
      get: (target, key, receiver) => {
        if (key === "constructor") {
          throw new Error("poisoned constructor via Reflect.get");
        }
        return Reflect.get(target, key, receiver);
      },
    });
  },
});

export const returnSpeciesPoisonedArray = task<void, unknown>({
  f: async () => {
    class SpeciesPoisonedArray<T> extends Array<T> {
      static get [Symbol.species]() {
        throw new Error("poisoned array species access");
      }
    }
    return new SpeciesPoisonedArray(1, 2, 3);
  },
});

export const returnSpeciesPoisonedNumericArray = task<void, unknown>({
  f: async () => {
    class SpeciesPoisonedNumericArray extends NumericArray {
      static get [Symbol.species]() {
        throw new Error("poisoned numeric array species access");
      }
    }
    const payload = new SpeciesPoisonedNumericArray();
    payload.push(4, 5, 6);
    return payload;
  },
});

export const returnSpeciesPoisonedUint8Array = task<void, unknown>({
  f: async () => {
    class SpeciesPoisonedUint8Array extends Uint8Array {
      static get [Symbol.species]() {
        throw new Error("poisoned Uint8Array species access");
      }
    }
    return new SpeciesPoisonedUint8Array([7, 8, 9]);
  },
});

export const returnForgedSharedArrayBufferPayload = task<void, unknown>({
  f: async () =>
    forgedExternalPayload(
      SHARED_ARRAY_BUFFER_CODEC_ID,
      () => ({
        kind: SHARED_ARRAY_BUFFER_CODEC_ID,
        origin: currentOrigin(),
        runtime: RUNTIME,
        pointer: "0",
        token: "9223372036854775807",
        byteLength: 8,
      }),
    ),
});

export const returnForgedBufferReferencePayload = task<void, unknown>({
  f: async () =>
    forgedExternalPayload(
      BUFFER_REFERENCE_CODEC_ID,
      () => ({
        kind: BUFFER_REFERENCE_CODEC_ID,
        origin: currentOrigin(),
        runtime: RUNTIME,
        pointer: "0",
        token: "9223372036854775807",
        byteOffset: 0,
        byteLength: 8,
      }),
    ),
});

export const attemptProcessExit = task<void, string>({
  f: async () => {
    process.exit(1);
    return "unreachable";
  },
});

export const attemptProcessKill = task<void, string>({
  f: async () => {
    process.kill(process.pid, "SIGTERM");
    return "unreachable";
  },
});

export const corruptSharedMemoryViaWorkerData = task<void, string>({
  f: async () => {
    const data = workerData as {
      lock: {
        headers: SharedBufferSource;
        lockSector: SharedBufferSource;
        payloadSector: SharedBufferSource;
      };
      returnLock: {
        headers: SharedBufferSource;
        lockSector: SharedBufferSource;
        payloadSector: SharedBufferSource;
      };
    };

    const views = [
      new Uint8Array(toSharedBufferRegion(data.lock.lockSector).sab),
      new Uint8Array(toSharedBufferRegion(data.lock.headers).sab),
      new Uint8Array(toSharedBufferRegion(data.lock.payloadSector).sab),
      new Uint8Array(toSharedBufferRegion(data.returnLock.lockSector).sab),
      new Uint8Array(toSharedBufferRegion(data.returnLock.headers).sab),
      new Uint8Array(toSharedBufferRegion(data.returnLock.payloadSector).sab),
    ];

    let i = 0;
    setInterval(() => {
      const view = views[i % views.length]!;
      view[(i * 17) % view.length] ^= 0xff;
      i++;
    }, 0);

    return "corrupted";
  },
});
