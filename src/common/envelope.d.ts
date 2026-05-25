type EnvelopeHeaderPrimitive = string | number | boolean | null;
type EnvelopeHeaderValue = EnvelopeHeaderPrimitive | EnvelopeHeaderValue[] | {
    [key: string]: EnvelopeHeaderValue;
};
export type EnvelopeHeader = EnvelopeHeaderValue;
export declare class Envelope<H extends EnvelopeHeader = EnvelopeHeader> {
    readonly header: H;
    readonly payload: ArrayBuffer;
    constructor(header: H, payload: ArrayBuffer);
}
export {};
