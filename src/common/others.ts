// Generate unique task IDs.
export const genTaskID = ((counter: number) => () => counter++)(0);

// Get the current file's path.
export const currentPath = () => new URL(import.meta.url);

// Bun has a different Offset than Deno and Node
//@ts-ignore
const IS_BUN = typeof Bun == "object" && Bun !== null;



const getCallerFilePathForBun = (offset: number) => {

   // @ts-ignore
  const originalStackTrace = Error.prepareStackTrace;
   // @ts-ignore
  Error.prepareStackTrace = (_, stack) => stack;
  const err = new Error();
   // @ts-ignore
  const stack = err.stack as unknown as NodeJS.CallSite[];
   // @ts-ignore
  Error.prepareStackTrace = originalStackTrace;
  const caller = stack[offset]?.getFileName();

  if (!caller) {
    throw new Error("Unable to determine caller file.");
  }

  let url: URL;
  try {
    url = new URL(caller);
  } catch (error) {
    url = new URL("file://" + caller);
  }

  return url.href;
};

/**
 * Helps to get the right exported function from the file
 */
const linkingMap = new Map<string, null>();

export const getCallerFilePath = () => {
  const stackOffset = IS_BUN ? 2 : 3;
  const href = getCallerFilePathForBun(stackOffset);

  return href;
};

import { hrtime } from "node:process";

export const beat = (): number => Number(hrtime.bigint()) / 1e4;

import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { OP_TAG } from "../ipc/transport/shared-memory.ts";

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

  // ─── file logging setup ──────────────────────────────────────────
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const logDir = join(process.cwd(), "log");
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const born = startAt;
  const logFile = join(logDir, `${isMain ? "M" : "T"}_${thread}_${born}.log`);
  const stream = createWriteStream(logFile, { flags: "a" });

  // ─── timing & counting state ─────────────────────────────────────
  let last = op[0];
  let lastBeat = born;
  let hitsTotal = 0;
  const hitsPerValue: Record<number, number> = { [last]: 0 };

  // ─── header row ─────────────────────────────────────────────────

  const header =
    `${color}Thread${tab}Tag${tab}Value${tab}SinceBorn${tab}SinceLast${tab}HitsPrev${tab}TotalHits${reset}`;
  stream.write(stripAnsi(header) + "\n");

  // ─── log when the tracked slot’s value changes ──────────────────
  function maybeLog(value: number, tag: string) {
    hitsTotal++;
    hitsPerValue[value] = (hitsPerValue[value] ?? 0) + 1;

    if (value !== last) {
      const now = isMain ? beat() : beat() + born;
      const hits = hitsPerValue[last];

      const line =
        `${color}${isMain ? "M" : "T"}${thread}${reset}${tab}${tab}` + // thread
        `${tag}${
          // @ts-ignore
          String(OP_TAG[last]! ?? last).padStart(1, " ")}${reset}${tab}` + // tag + prev value
        `${(now - born).toFixed(2).padStart(9)}${tab}` + // since born
        `${(now - lastBeat).toFixed(2).padStart(9)}${tab}` + // since last
        `${hits.toString().padStart(8)}${tab}` + // hits of prev
        `${hitsTotal.toString().padStart(9)}`; // total hits

      stream.write(stripAnsi(line) + "\n");

      last = value;
      lastBeat = now;
    }
  }

  // ─── proxy that logs reads/writes of element 0 & .set() ─────────
  const proxied = new Proxy(op, {
    get(target, prop, receiver) {
      // accept both "0" and 0
      if (prop === "0") {
        // IMPORTANT: use the underlying Int32Array, not the Proxy
        const value = Atomics.load(target as unknown as Int32Array, 0);
        maybeLog(value, "GET ");
        return value;
      }
      return Reflect.get(target, prop as any, receiver);
    },
    set(target, prop, value, receiver) {
      const ok = Reflect.set(target, prop as any, value, receiver);
      if (ok && (prop === "0")) {
        // No Atomics here—just log the value we set
        maybeLog(value as number, "PUT ");
      }
      return ok;
    },
  }) as unknown as Int32Array;

  return proxied;
};
