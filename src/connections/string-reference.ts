import { getNodeProcess } from "../common/node-compat.ts";
import { RUNTIME } from "../common/runtime.ts";
import { getNativeStrings } from "./string-reference-native.ts";

export const STRING_REFERENCE_CODEC_ID = "knitting.stringReference";
export const STRING_REFERENCE_KIND = "knitting.stringReference";
export type StringReferenceRuntime = "node" | "deno" | "bun";
export type StringReferenceMetadata = {
  kind: typeof STRING_REFERENCE_KIND;
  runtime: StringReferenceRuntime;
  origin: string;
  token: string;
  length: number;
};
const origin = `${RUNTIME}:${getNodeProcess()?.pid}`;
const brand = Symbol.for("knitting.payloadCodec");
const transportFinalizer = Symbol.for(
  "knitting.payloadCodec.transportFinalizer",
);
const genuine = new WeakSet<object>();
const finalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry<bigint>((token) => {
    getNativeStrings().release(token);
  })
  : undefined;
const ownedToken = Symbol("owned string token");

export function isStringReferenceMetadata(
  value: unknown,
): value is StringReferenceMetadata {
  if (!value || typeof value !== "object") return false;
  const m = value as StringReferenceMetadata;
  return m.kind === STRING_REFERENCE_KIND &&
    ["node", "deno", "bun"].includes(m.runtime) &&
    typeof m.origin === "string" && typeof m.token === "string" &&
    /^[1-9]\d{0,19}$/.test(m.token) && BigInt(m.token) <= 0xffffffffffffffffn &&
    Number.isInteger(m.length) && m.length >= 0 && m.length <= 32 * 1024 * 1024;
}
export const isStringReferenceValue = (
  value: unknown,
): value is StringReference =>
  typeof value === "object" && value !== null && genuine.has(value);

/** Experimental immutable, process-local string storage shared between thread workers.
 * Construction copies characters into native storage (one byte per ASCII code unit,
 * two bytes otherwise). clone() shares storage; toString() may copy on runtimes
 * without external strings. release() drops this owner's hold, while
 * other references and materialized strings remain valid.
 */
export class StringReference {
  readonly [brand] = STRING_REFERENCE_CODEC_ID;
  readonly length: number;
  readonly byteLength: number;
  readonly runtime = RUNTIME as StringReferenceRuntime;
  #token: bigint;
  #holds = 0;
  #disposed = false;
  #released = false;
  #text: string | undefined;

  constructor(text: string);
  constructor(text: string | bigint, secret?: symbol) {
    if (secret !== ownedToken && typeof text !== "string") {
      throw new TypeError("StringReference expects a string");
    }
    if (!["node", "deno", "bun"].includes(RUNTIME)) {
      throw new Error("StringReference requires Node, Deno or Bun");
    }
    const native = getNativeStrings();
    this.#token = secret === ownedToken
      ? text as bigint
      : native.retain(text as string);
    try {
      const storage = native.describe(this.#token);
      this.length = storage.length;
      this.byteLength = storage.byteLength;
    } catch (error) {
      native.release(this.#token);
      throw error;
    }
    genuine.add(this);
    finalizer?.register(this, this.#token, this);
  }
  static #own(token: bigint): StringReference {
    // Internal overload cannot be reached through the public constructor signature.
    return new (StringReference as unknown as new (
      token: bigint,
      secret: symbol,
    ) => StringReference)(token, ownedToken);
  }
  static fromMetadata(metadata: unknown): StringReference {
    if (!isStringReferenceMetadata(metadata)) {
      throw new TypeError("Invalid StringReference metadata");
    }
    if (metadata.origin !== origin || metadata.runtime !== RUNTIME) {
      throw new TypeError(
        "StringReference cannot cross a process or runtime boundary",
      );
    }
    const reference = StringReference.#own(
      getNativeStrings().clone(BigInt(metadata.token)),
    );
    if (reference.length !== metadata.length) {
      reference.release();
      throw new TypeError(
        "StringReference length does not match native storage",
      );
    }
    return reference;
  }
  #assertLive(): void {
    if (this.#disposed) throw new Error("StringReference has been released");
  }
  clone(): StringReference {
    this.#assertLive();
    return StringReference.#own(getNativeStrings().clone(this.#token));
  }
  toString(): string {
    this.#assertLive();
    return this.#text ??= getNativeStrings().adopt(this.#token);
  }
  toMetadata(): StringReferenceMetadata {
    this.#assertLive();
    return {
      kind: STRING_REFERENCE_KIND,
      runtime: this.runtime,
      origin,
      token: String(this.#token),
      length: this.length,
    };
  }
  #releaseIfIdle(): void {
    if (this.#disposed && this.#holds === 0 && !this.#released) {
      this.#released = true;
      finalizer?.unregister(this);
      getNativeStrings().release(this.#token);
    }
  }
  [transportFinalizer](): () => void {
    this.#assertLive();
    this.#holds++;
    let done = false;
    return () => {
      if (!done) {
        done = true;
        this.#holds--;
        this.#releaseIfIdle();
      }
    };
  }
  release(): void {
    this.#disposed = true;
    this.#text = undefined;
    this.#releaseIfIdle();
  }
  [Symbol.dispose](): void {
    this.release();
  }
}
const host = globalThis as typeof globalThis & {
  __KNITTING_PAYLOAD_CODECS__?: Record<
    string,
    { decode(metadata: unknown): unknown }
  >;
};
(host.__KNITTING_PAYLOAD_CODECS__ ??= Object.create(null))[
  STRING_REFERENCE_CODEC_ID
] = {
  decode: (metadata: unknown) => StringReference.fromMetadata(metadata),
};
