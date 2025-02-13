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
    payload.set(task[6], 0);
    payloadLenght[0] = task[6].length;
    id[0] = task[3];
  };

export const sendUintMessage =
  ({ id, payload, payloadLenght }: SignalArguments) => (task: MainList) => {
    payload.set(task[3], 0);
    payloadLenght[0] = task[3].length;
    id[0] = task[2];
  };

export const getCallerFile = (n: number) => {
  const err = new Error();
  const stack = err?.stack;

  if (typeof stack === "undefined") {
    throw new Error("Unable to determine caller file.");
  } else {
    
    const path = fromStackStringToFiles(stack);
  
    if(!ISDENO){
      return "file://" + path[path.length - 1]
    }
    return path[path.length - 1];
  }
};

// This thing is annoying asf
//@ts-ignore
const ISDENO = typeof Deno == 'object' && Deno !== null

const fromStackStringToFiles = (str: string) =>
  str.split(" ")
    .filter((s) => 
      ISDENO ? s.includes("://")
      :  s.includes("(/"))
    .map((s) => s.replaceAll("(", "").replaceAll(")", ""))
    .map((s) => {
      // There's not way this will work in the future
      // TODO: make this more robust
      const next = ISDENO
        ? s.indexOf(":", s.indexOf(":") + 1)
        :  s.indexOf(":") ;

      return s.slice(0, next);
    });
