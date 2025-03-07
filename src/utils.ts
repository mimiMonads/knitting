import type { MainList, QueueList } from "./mainQueueManager.ts";
import type { SignalArguments } from "./signals.ts";


// Generate unique task IDs.
export const genTaskID = ((counter: number) => () => counter++)(0);

// Get the current file's path.
export const currentPath = () => new URL(import.meta.url);

// Read a message from a Uint8Array.
export const readPayload =
  ({ payload, payloadLenght }: SignalArguments) => () =>
    payload.subarray(0, payloadLenght[0].valueOf());

// Write a Uint8Array message with task metadata.
export const writePayload =
  ({ id, payload, payloadLenght }: SignalArguments) => (task: QueueList) => {
    payload.set(task[4], 0);
    payloadLenght[0] = task[4].length;
    id[0] = task[1];
  };

export const sendPayload =
  ({ id, payload, payloadLenght }: SignalArguments) => (task: MainList) => {
    payload.set(task[1]);
    payloadLenght[0] = task[1].length;
    id[0] = task[0];
  };

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

  return "file://" + caller;
};

export const getCallerFilePath = (n: number) => {
  if (!IS_DENO) {
    return getCallerFilePathForBun(n);
  }

  const err = new Error();
  const stack = err?.stack;

  if (typeof stack === "undefined") {
    throw new Error("Unable to determine caller file.");
  } else {
    const path = parseStackTraceFiles(stack);
    return path[path.length - 1];
  }
};

// This thing is annoying asf
//@ts-ignore -> Reason -> Deno types are not installed
const IS_DENO = typeof Deno == "object" && Deno !== null;

const parseStackTraceFiles = (str: string) =>
  str.split(" ")
    .filter((s) => s.includes("://"))
    .map((s) => s.replaceAll("(", "").replaceAll(")", ""))
    .map((s) => {
      // There's not way this will work in the future
      // TODO: make this more robust
      const next = s.indexOf(":", s.indexOf(":") + 1);

      return s.slice(0, next);
    });
