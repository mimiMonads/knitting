import { Envelope, task } from "../../knitting.ts";
import { BufferReference } from "../../unsafe.ts";

export const echoEnvelope = task<Envelope, Envelope>({
  f: async (envelope) => envelope,
});

export const bumpEnvelopeShared = task<
  Envelope<{ tag: string }, SharedArrayBuffer>,
  Envelope<{ tag: string }, SharedArrayBuffer>
>({
  f: (envelope) => {
    const view = new Uint8Array(envelope.payload);
    view[0] = (view[0]! + 1) & 0xff;
    return new Envelope(
      { tag: envelope.header.tag + ":seen" },
      envelope.payload,
    );
  },
});

export const invertEnvelope = task<
  Envelope<{ op: string }, BufferReference>,
  Envelope<{ op: string }, BufferReference>
>({
  f: (envelope) => {
    const pixels = envelope.payload.toUint8Array();
    const out = new Uint8Array(pixels.length);
    for (let i = 0; i < pixels.length; i++) out[i] = 255 - pixels[i]!;
    return new Envelope(
      { op: envelope.header.op + ":done" },
      new BufferReference(out),
    );
  },
});
