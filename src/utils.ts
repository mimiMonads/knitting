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

  // Old deno code that doesn't work anymore

  // const parseStackTraceFiles = (str: string) =>
  //   str.split(" ")
  //     .filter((s) => s.includes("://"))
  //     .map((s) => s.replaceAll("(", "").replaceAll(")", ""))
  //     .map((s) => {
  //       // There's not way this will work in the future
  //       // TODO: make this more robust
  //       const next = s.indexOf(":", s.indexOf(":") + 1);

  //       return s.slice(0, next);
  //     });

  // const err = new Error();
  // const stack = err?.stack;

  // if (typeof stack === "undefined") {
  //   throw new Error("Unable to determine caller file.");
  // } else {
  //   const path = parseStackTraceFiles(stack);
  //   if (path.length < n + 1) {
  //     throw new Error(
  //       `Unable to determine caller file. Expected at least ${
  //         n + 1
  //       } stack frames, but got ${path.length}.`,
  //     );
  //   }
  //   return path[path.length - 1];
  // }
};
import { hrtime } from "node:process";

const beat = (): number => Number(hrtime.bigint()) / 1e6;

/**
 * Debug reads & writes to status[0] without touching `performance.now()`.
 * “Time” columns are driven by the `beat()` heart‑beat instead.
 */
export const signalDebuggerV2 = ({
  thread,
  isMain,
  status,
}: {
  thread: number;
  isMain: boolean;
  status: Int32Array;
}) => {
  // ─── colours & helpers ───────────────────────────────────────────
  const orange = "\x1b[38;5;214m";
  const purple = "\x1b[38;5;129m";
  const reset = "\x1b[0m";
  const tab = "\t";
  const color = isMain ? orange : purple;

  // ─── timing & counting state ─────────────────────────────────────
  let last = status[0];
  const born = beat(); // ms since heart‑beat origin
  let lastBeat = born; // last change time

  let hitsTotal = 0;
  const hitsPerValue: Record<number, number> = { [last]: 0 };

  // ─── proxy that logs every read/write of element 0 ───────────────
  const proxied = new Proxy(status, {
    get(target, prop, receiver) {
      if (prop === "0") {
        const value = Reflect.get(target, 0, receiver) as number;
        maybeLog(value);
        return value;
      }
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value, receiver) {
      const ok = Reflect.set(target, prop, value, receiver);
      if (ok && prop === "0") maybeLog(value as number);
      return ok;
    },
  }) as unknown as Int32Array;

  // ─── log when the tracked slot’s value changes ──────────────────
  function maybeLog(value: number) {
    hitsTotal++;
    hitsPerValue[value] = (hitsPerValue[value] ?? 0) + 1;

    if (value !== last) {
      const now = beat();
      const from = last > 127 ? orange : purple; // colour by *old* value
      const hits = hitsPerValue[last]; // hits of the run we’re finishing

      console.log(
        `${color}${(isMain ? "M " : "T ") + (thread ?? "")}${reset}${tab}` + // thread
          `${from}${String(last).padStart(3, " ")}${reset}` + // previous value
          (isMain ? tab : tab + tab) +
          `${color}${(now - born).toFixed(2).padStart(6, " ")}${reset}` + // since born
          tab + tab + (now - lastBeat).toFixed(2).padStart(6, " ") + tab + // since last change
          tab + String(hits).padStart(4, " ") + // hits of prev value
          tab + String(hitsTotal).padStart(6, " "), // total hits
      );

      last = value;
      lastBeat = now;
    }
  }

  return proxied;
};
