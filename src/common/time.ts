// Generate unique task IDs.
export const genTaskID = ((counter: number) => () => counter++)(0);

// Get the current file's path.
export const currentPath = () => new URL(import.meta.url);

//@ts-ignore
const IS_BUN = typeof Bun == "object" && Bun !== null;

const getCallerFilePathForBun = (n: number) => {
  //@ts-ignore Reason -> Types
  const originalStackTrace = Error.prepareStackTrace;
  //@ts-ignore Reason -> Types
  Error.prepareStackTrace = (_, stack) => stack;
  const err = new Error();
  const stack = err.stack as unknown as NodeJS.CallSite[];
  //@ts-ignore Reason -> Types
  Error.prepareStackTrace = originalStackTrace;
  // Get the caller file
  const caller = stack[n]?.getFileName();

  if (!caller) {
    throw new Error("Unable to determine caller file.");
  }

  if (!caller.startsWith("file://")) {
    return "file://" + caller;
  }
  return caller;
};

export const getCallerFilePath = (n: number) => {
  return getCallerFilePathForBun(IS_BUN ? 2 : 3);
};

import { hrtime } from "node:process";

export const beat = (): number => Number(hrtime.bigint()) / 1e4;

/**
 * Debug reads & writes to op[0] without touching `performance.now()`.
 * “Time” columns are driven by the `beat()` heart-beat instead.
 */
export const signalDebuggerV2 = ({
  thread,
  isMain,
  op,
  startAt,
}: {
  thread: number;
  isMain: boolean;
  op: Int32Array;
  startAt: number;
}) => {
  // ─── colours & helpers ───────────────────────────────────────────
  const orange = "\x1b[38;5;214m";
  const purple = "\x1b[38;5;129m";
  const reset = "\x1b[0m";
  const tab = "\t";
  const color = isMain ? orange : purple;

  // ─── timing & counting state ─────────────────────────────────────
  
  let last = op[0];
  const born = startAt;
  let lastBeat = born;
  let hitsTotal = 0;
  const hitsPerValue: Record<number, number> = { [last]: 0 };

  // ─── header row ─────────────────────────────────────────────────
  if (thread === 0) {
    console.log(
      `${color}Thread${tab}Tag${tab}Value${tab}SinceBorn${tab}SinceLast${tab}HitsPrev${tab}TotalHits${reset}`,
    );
  }

  // ─── log when the tracked slot’s value changes ──────────────────
  function maybeLog(value: number, tag: string) {
    hitsTotal++;
    hitsPerValue[value] = (hitsPerValue[value] ?? 0) + 1;

    if (value !== last) {
      const now = isMain ? beat() : beat() + born;
      const hits = hitsPerValue[last];

      console.log(
        `${color}${isMain ? "M" : "T"}${thread}${reset}${tab}` + // thread
          `${tag}${String(last).padStart(6, " ")}${reset}${tab}` + // tag + prev value
          `${(now - born).toFixed(2).padStart(9)}${tab}` + // since born
          `${(now - lastBeat).toFixed(2).padStart(9)}${tab}` + // since last
          `${hits.toString().padStart(8)}${tab}` + // hits of prev
          `${hitsTotal.toString().padStart(9)}`, // total hits
      );

      last = value;
      lastBeat = now;
    }
  }

  // ─── proxy that logs reads/writes of element 0 & .set() ─────────
  const proxied = new Proxy(op, {
    get(target, prop, receiver) {
      // intercept .set()
      if (prop === "set") {
        const orig = target.set;
        return function (arr: ArrayLike<number>, offset = 0) {
          const res = orig.call(target, arr, offset);
          if (offset === 0 && arr.length > 0) maybeLog(arr[0], "SET() ");
          return res;
        };
      }
      // direct index read
      if (prop === "0") {
        const v = Reflect.get(target, 0, receiver) as number;
        maybeLog(v, "GET   ");
        return v;
      }
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value, receiver) {
      if (prop === "0") maybeLog(value as number, "PUT   ");
      return Reflect.set(target, prop, value, receiver);
    },
  }) as unknown as Int32Array;

  return proxied;
};
