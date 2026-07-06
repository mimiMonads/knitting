import { getNodeBuiltinModule, getNodeProcess } from "../common/node-compat.ts";

export type NodeFfiFunctionSignature = {
  arguments?: string[];
  return?: string;
};

export type NodeFfiLibrary = {
  close: () => void;
};

export type NodeFfiDlopenResult<
  Functions extends Record<string, (...args: never[]) => unknown>,
> = {
  functions: Functions;
  lib: NodeFfiLibrary;
};

export type NodeFfiApi = {
  dlopen: <
    Functions extends Record<string, (...args: never[]) => unknown>,
  >(
    path: string | null,
    definitions: Record<string, NodeFfiFunctionSignature>,
  ) => NodeFfiDlopenResult<Functions>;
  getRawPointer: (
    source: ArrayBuffer | SharedArrayBuffer | ArrayBufferView,
  ) => bigint;
  suffix: string;
  toArrayBuffer: (
    pointer: bigint,
    length: number,
    copy?: boolean,
  ) => ArrayBuffer;
};

const readNodeMajor = (): number | undefined => {
  const version = getNodeProcess()?.versions?.node;
  if (typeof version !== "string") return undefined;
  const major = Number.parseInt(version.split(".", 1)[0] ?? "", 10);
  return Number.isInteger(major) ? major : undefined;
};

export const isNodeFfiTarget = (): boolean => {
  const major = readNodeMajor() ?? 0;
  return major >= 26 && major % 2 === 0;
};

let cachedNodeFfi: NodeFfiApi | undefined;

export const getNodeFfi = (): NodeFfiApi => {
  if (cachedNodeFfi !== undefined) return cachedNodeFfi;

  const ffi = getNodeBuiltinModule<NodeFfiApi>("node:ffi");
  if (
    ffi === undefined ||
    typeof ffi.dlopen !== "function" ||
    typeof ffi.getRawPointer !== "function" ||
    typeof ffi.toArrayBuffer !== "function"
  ) {
    throw new Error(
      "knitting: Node.js 26 native features require node:ffi. " +
        "Restart Node with --experimental-ffi" +
        " (--allow-ffi is also required when using Node's Permission Model).",
    );
  }

  cachedNodeFfi = ffi;
  return ffi;
};
