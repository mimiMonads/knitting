import { writeFileSync } from "node:fs";
import { task } from "../../knitting.ts";

let polls = 0;
let observing = false;

// Observe the dispatcher's short backoff timers inside the child. Long task
// timers are excluded, so a quiet pending await should report zero polls.
export const holdForAsyncPark = task<number, number>({
  f: async (ms) => {
    if (!observing) {
      observing = true;
      const original = globalThis.setTimeout;
      const observingAt = performance.now();
      globalThis.setTimeout = ((callback, delay, ...args) => {
        // Exclude the first host/worker readiness handshake. Quiet awaits
        // after activation must arm no periodic dispatcher timers.
        if (typeof delay === "number" && delay > 0 && delay <= 10 &&
          performance.now() - observingAt >= 50) ++polls;
        return original(callback, delay, ...args);
      }) as typeof setTimeout;
    }
    await new Promise((resolve) => setTimeout(resolve, ms));
    return polls;
  },
});

export const readAsyncParkPolls = task<void, number>({ f: () => polls });

export const disconnectDuringAsyncPark = task<void, void>({
  f: () => {
    setTimeout(() => process.disconnect?.(), 30);
  },
});

export const rejectAfterAsyncPark = task<void, never>({
  f: async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    throw new Error("awaited task rejected");
  },
});

let capacityHeld = 0;
export const occupyAsyncCapacity = task<number, boolean | Promise<boolean>>({
  f: (pid) => {
    if (pid !== process.pid) return false;
    ++capacityHeld;
    process.send?.({ __knittingCapacityHeld: capacityHeld, pid });
    return new Promise<boolean>(() => {});
  },
});

export const awaitWithMarker = task<string, Promise<void>>({
  f: async (file) => {
    // The microtask runs after the dispatcher has counted this await.
    queueMicrotask(() => writeFileSync(file, "awaiting"));
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  },
});
export const markAsyncClaim = task<string, void>({
  f: (file) => writeFileSync(file, "claimed"),
});
