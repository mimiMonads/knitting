import type { BufferReference } from "../connections/buffer-reference.ts";
import type { ProcessSharedBuffer } from "../connections/process-shared-buffer.ts";

type EnvelopeHeaderPrimitive = string | number | boolean | null;

type EnvelopeHeaderValue =
  | EnvelopeHeaderPrimitive
  | EnvelopeHeaderValue[]
  | { [key: string]: EnvelopeHeaderValue };

export type EnvelopeHeader = EnvelopeHeaderValue;

export type EnvelopeBody =
  | ArrayBuffer
  | SharedArrayBuffer
  | BufferReference
  | ProcessSharedBuffer;

const PayloadTransportFinalizer = Symbol.for(
  "knitting.payloadCodec.transportFinalizer",
);

type MaybeDisposable = { [Symbol.dispose]?: () => void };
type MaybeTransportFinalizable = {
  [PayloadTransportFinalizer]?: () => (() => void) | undefined;
};

export class Envelope<
  H extends EnvelopeHeader = EnvelopeHeader,
  B extends EnvelopeBody = ArrayBuffer,
> {
  public readonly header: H;
  public readonly payload: B;

  constructor(header: H, payload: B) {
    this.header = header;
    this.payload = payload;
  }

  [Symbol.dispose](): void {
    const body = this.payload as MaybeDisposable | null;
    if (body !== null && typeof body === "object") {
      body[Symbol.dispose]?.();
    }
  }

  [PayloadTransportFinalizer](): (() => void) | undefined {
    const body = this.payload as MaybeTransportFinalizable | null;
    if (body === null || typeof body !== "object") return undefined;
    const finalizer = body[PayloadTransportFinalizer];
    return typeof finalizer === "function" ? finalizer.call(body) : undefined;
  }
}
