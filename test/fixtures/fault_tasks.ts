import { task } from "../../knitting.ts";
import type { SharedBufferSource } from "../../src/common/shared-buffer-region.ts";
import { workerData } from "node:worker_threads";

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
    const toBytes = (value: SharedBufferSource) =>
      value instanceof SharedArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.sab, value.byteOffset, value.byteLength);
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
      toBytes(data.lock.lockSector),
      toBytes(data.lock.headers),
      toBytes(data.lock.payloadSector),
      toBytes(data.returnLock.lockSector),
      toBytes(data.returnLock.headers),
      toBytes(data.returnLock.payloadSector),
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
