import { task } from "../../knitting.ts";
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
    const data = workerData as {
      lock: {
        headers: SharedArrayBuffer;
        lockSector: SharedArrayBuffer;
        payloadSector: SharedArrayBuffer;
      };
      returnLock: {
        headers: SharedArrayBuffer;
        lockSector: SharedArrayBuffer;
        payloadSector: SharedArrayBuffer;
      };
    };

    const views = [
      new Uint8Array(data.lock.lockSector),
      new Uint8Array(data.lock.headers),
      new Uint8Array(data.lock.payloadSector),
      new Uint8Array(data.returnLock.lockSector),
      new Uint8Array(data.returnLock.headers),
      new Uint8Array(data.returnLock.payloadSector),
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
