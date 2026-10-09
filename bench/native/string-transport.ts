import { nativeStrings } from "./string-reference.mjs";

// Private experiment using real external-payload framing and transport holds.
// Callers and worker functions both accept ordinary primitive strings.
const codecId = "knitting.bench.nativeString";
const brand = Symbol.for("knitting.payloadCodec");
const transportFinalizer = Symbol.for(
  "knitting.payloadCodec.transportFinalizer",
);
const host = globalThis as typeof globalThis & {
  __KNITTING_PAYLOAD_CODECS__?: Record<string, {
    decode: (metadata: unknown) => unknown;
  }>;
};
const codecs = host.__KNITTING_PAYLOAD_CODECS__ ??= Object.create(null);
codecs[codecId] = {
  decode: (metadata: unknown) => {
    if (typeof metadata !== "string" || !/^\d+$/.test(metadata)) {
      throw new TypeError("Invalid native string token");
    }
    return nativeStrings.adopt(BigInt(metadata));
  },
};

class NativeStringPayload {
  readonly [brand] = codecId;
  #token: bigint;
  #holds = 0;
  #disposed = false;
  #released = false;
  constructor(text: string) {
    this.#token = nativeStrings.retain(text);
  }
  toMetadata(): string {
    return String(this.#token);
  }
  #releaseIfIdle(): void {
    if (this.#disposed && this.#holds === 0 && !this.#released) {
      this.#released = true;
      nativeStrings.release(this.#token);
    }
  }
  [transportFinalizer](): () => void {
    this.#holds++;
    let finalized = false;
    return () => {
      if (finalized) return;
      finalized = true;
      this.#holds--;
      this.#releaseIfIdle();
    };
  }
  dispose(): void {
    this.#disposed = true;
    this.#releaseIfIdle();
  }
}

/** Native allocation, framing and disposal are included in this call. */
export async function callNativeString<T>(
  send: (text: string) => Promise<T>,
  text: string,
): Promise<T> {
  if (text.length === 0) return await send(text);
  const payload = new NativeStringPayload(text);
  try {
    return await send(payload as unknown as string);
  } finally {
    payload.dispose();
  }
}

/** Candidate policy using UTF-16 size, available without a UTF-8 scan. */
export function callAutoString<T>(
  send: (text: string) => Promise<T>,
  text: string,
  nativeAboveBytes = 64 * 1024,
): Promise<T> {
  return text.length * 2 >= nativeAboveBytes
    ? callNativeString(send, text)
    : send(text);
}
