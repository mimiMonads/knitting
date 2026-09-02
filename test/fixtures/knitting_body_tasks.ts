import { task } from "../../knitting.ts";
import type { KnittingBodyWire } from "../../src/memory/knitting-body.ts";
import { openBody } from "./knitting_body_bootstrap.ts";

/**
 * One task for every transport: the wire resolves to bytes and the task never
 * learns which way the body arrived.
 */
export const digestBody = task<KnittingBodyWire, number>({
  f: (wire) => {
    const bytes = openBody(wire);
    let sum = 0;
    for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i]!) & 0xffffff;
    return (sum << 8) | (bytes.byteLength & 0xff);
  },
});
