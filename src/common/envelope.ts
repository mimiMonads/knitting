type EnvelopeHeaderPrimitive = string | number | boolean | null;

type EnvelopeHeaderValue =
  | EnvelopeHeaderPrimitive
  | EnvelopeHeaderValue[]
  | { [key: string]: EnvelopeHeaderValue };

export type EnvelopeHeader = EnvelopeHeaderValue;

export class Envelope<H extends EnvelopeHeader = EnvelopeHeader> {
  public readonly header: H;
  public readonly payload: ArrayBuffer;

  constructor(header: H, payload: ArrayBuffer) {
    this.header = header;
    this.payload = payload;
  }
}
