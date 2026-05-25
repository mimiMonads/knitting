import { type SharedBufferSource } from "../common/shared-buffer-region.js";
export declare const PAYLOAD_DEFAULT_MAX_BYTE_LENGTH: number;
export declare const PAYLOAD_DEFAULT_INITIAL_BYTES: number;
export type PayloadBufferMode = "growable" | "fixed";
export type PayloadBufferOptions = {
    mode?: PayloadBufferMode;
    payloadInitialBytes?: number;
    payloadMaxByteLength?: number;
    maxPayloadBytes?: number;
};
export type ResolvedPayloadBufferOptions = {
    mode: PayloadBufferMode;
    payloadInitialBytes: number;
    payloadMaxByteLength: number;
    maxPayloadBytes: number;
};
type PayloadBackingBuffer = SharedArrayBuffer | ArrayBuffer;
export declare const resolvePayloadBufferOptions: ({ options, sab, }: {
    options?: PayloadBufferOptions;
    sab?: PayloadBackingBuffer | SharedBufferSource;
}) => ResolvedPayloadBufferOptions;
export {};
