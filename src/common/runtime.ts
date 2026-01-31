type RuntimeName = "deno" | "bun" | "node" | "unknown";

type GlobalWithRuntimes = typeof globalThis & {
  Deno?: { version?: { deno?: string } };
  Bun?: { version?: string };
  setImmediate?: (cb: () => void) => void;
};

const globals = globalThis as GlobalWithRuntimes;

export const IS_DENO = typeof globals.Deno?.version?.deno === "string";
export const IS_BUN = typeof globals.Bun?.version === "string";
export const IS_NODE =
  typeof process !== "undefined" && typeof process.versions?.node === "string";

export const RUNTIME = (
  IS_DENO ? "deno" : IS_BUN ? "bun" : IS_NODE ? "node" : "unknown"
) as RuntimeName;

export const SET_IMMEDIATE =
  typeof globals.setImmediate === "function" ? globals.setImmediate : undefined;

export const HAS_SAB_GROW =
  typeof SharedArrayBuffer === "function" &&
  typeof (SharedArrayBuffer.prototype as { grow?: unknown }).grow === "function";

export const createSharedArrayBuffer = (
  byteLength: number,
  maxByteLength?: number,
) => {
  if (HAS_SAB_GROW && typeof maxByteLength === "number") {
    return new SharedArrayBuffer(byteLength, { maxByteLength });
  }
  return new SharedArrayBuffer(byteLength);
};
