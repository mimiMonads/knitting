import type { MainList, QueueList } from "./mainQueue.ts";
import type { SignalArguments } from "./signal.ts";

// Signals
type StatusSignalForVoid = 224;
type StatusSignalForMessage = 192;
export type StatusSignal = StatusSignalForVoid | StatusSignalForMessage;

// Generate unique task IDs.
export const genTaskID = ((counter: number) => () => counter++)(0);

// Get the current file's path.
export const currentPath = () => new URL(import.meta.url);

// Read a message from a Uint8Array.
export const readMessageToUint =
  ({ payload, payloadLenght }: SignalArguments) => () =>
    payload.slice(0, payloadLenght[0].valueOf());

// Write a Uint8Array message with task metadata.
export const writeUintMessage =
  ({ id, payload, payloadLenght }: SignalArguments) => (task: QueueList) => {
    payload.set(task[4], 0);
    payloadLenght[0] = task[4].length;
    id[0] = task[1];
  };

export const sendUintMessage =
  ({ id, payload, payloadLenght }: SignalArguments) => (task: MainList) => {
    payload.set(task[1]);
    payloadLenght[0] = task[1].length;
    id[0] = task[0];
  };

const getCallerFileForBun = (n: number) => {
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

export const getCallerFile = (n: number) => {
  if (!ISDENO) {
    return getCallerFileForBun(n);
  }

  const err = new Error();
  const stack = err?.stack;

  if (typeof stack === "undefined") {
    throw new Error("Unable to determine caller file.");
  } else {
    const path = fromStackStringToFiles(stack);
    return path[path.length - 1];
  }
};

// This thing is annoying asf
//@ts-ignore -> Reason -> Deno types are not installed
const ISDENO = typeof Deno == "object" && Deno !== null;

const fromStackStringToFiles = (str: string) =>
  str.split(" ")
    .filter((s) => s.includes("://"))
    .map((s) => s.replaceAll("(", "").replaceAll(")", ""))
    .map((s) => {
      // There's not way this will work in the future
      // TODO: make this more robust
      const next = s.indexOf(":", s.indexOf(":") + 1);

      return s.slice(0, next);
    });
