import { toModuleUrl } from "./module-url.ts";

export const genTaskID = ((counter: number) => () => counter++)(0);

const resolveCallerHref = (offset: number): string => {
  const original = (Error as typeof Error & {
    prepareStackTrace?: (error: Error, stack: NodeJS.CallSite[]) => unknown;
  }).prepareStackTrace;
  (Error as typeof Error & {
    prepareStackTrace?: (error: Error, stack: NodeJS.CallSite[]) => unknown;
  }).prepareStackTrace = (_error, stack) => stack;
  const stack = new Error().stack as unknown as NodeJS.CallSite[] | undefined;
  (Error as typeof Error & {
    prepareStackTrace?: (error: Error, stack: NodeJS.CallSite[]) => unknown;
  }).prepareStackTrace = original;
  const caller = stack?.[offset]?.getFileName();

  if (!caller) {
    throw new Error("Unable to determine caller file.");
  }

  return toModuleUrl(caller);
};

const linkingMap = new Map<string, number>();

export const getCallerFilePath = () => {
  const href = resolveCallerHref(3);
  const at = linkingMap.get(href) ?? 0;
  linkingMap.set(href, at + 1);
  return [href, at] as [string, number];
};
