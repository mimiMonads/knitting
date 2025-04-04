// Generate unique task IDs.
export const genTaskID = ((counter: number) => () => counter++)(0);

// Get the current file's path.
export const currentPath = () => new URL(import.meta.url);

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

export const signalDebugger = ({
  thread,
  isMain,
  currentSignal,
}: {
  thread?: number;
  isMain?: true;
  currentSignal: { (arg: void): number };
}) => {
  let last = 255;
  let thisOne = 255;
  const builtAt = performance.now();

  const orange = "\x1b[38;5;214m"; // Orange
  const purple = "\x1b[38;5;129m"; // Purple
  const reset = "\x1b[0m";
  const tab = "\t"; // tab

  return () => {
    thisOne = currentSignal();
    if (last !== thisOne) {
      console.log(
        `${orange}${(isMain ? "M" : "T") + thread}${reset}` + tab +
          `${purple}${String(thisOne).padStart(3, " ")}${reset}` +
          (isMain === true ? tab : tab + tab) +
          `${orange}${
            (performance.now() - builtAt).toFixed(2).padStart(6, " ")
          }${reset}`,
      );
      last = thisOne;
    }
    return thisOne;
  };
};
