import {
  createBodyReader,
  type KnittingBodyWire,
  type KnittingTransport,
} from "../../src/memory/knitting-body.ts";

let reader: ((wire: KnittingBodyWire) => Uint8Array) | undefined;

/** Bootstrap: attach this worker to the host arena once. */
export const setup = (transport: KnittingTransport): void => {
  reader = createBodyReader(transport);
};

/** Typed, module-scoped, and shared with any task module that imports it. */
export const openBody = (wire: KnittingBodyWire): Uint8Array => {
  if (reader === undefined) throw new Error("body reader not attached");
  return reader(wire);
};
