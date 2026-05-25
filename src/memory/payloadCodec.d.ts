import { type PromisePayloadHandler, type Task } from "./lock.js";
import type { LockBufferTextCompat } from "../common/shared-buffer-text.js";
import { type PayloadBufferOptions } from "./payload-config.js";
import type { SharedBufferSource } from "../common/shared-buffer-region.js";
/**
 * Returns `true` when the payload is encoded successfully.
 * Returns `false` when dynamic payload space could not be reserved.
 */
export declare const encodePayload: ({ lockSector, payload, sab, payloadConfig, headersBuffer, headerSlotStrideU32, textCompat, onPromise, }: {
    lockSector?: SharedBufferSource;
    payload?: {
        sab?: SharedBufferSource;
        config?: PayloadBufferOptions;
    };
    /**
     * @deprecated Use `payload.sab`.
     */
    sab?: SharedBufferSource;
    /**
     * @deprecated Use `payload.config`.
     */
    payloadConfig?: PayloadBufferOptions;
    headersBuffer: Uint32Array;
    headerSlotStrideU32?: number;
    textCompat?: LockBufferTextCompat;
    onPromise?: PromisePayloadHandler;
}) => (task: Task, slotIndex: number) => boolean;
export declare const decodePayload: ({ lockSector, payload, sab, payloadConfig, headersBuffer, headerSlotStrideU32, textCompat, host, }: {
    lockSector?: SharedBufferSource;
    payload?: {
        sab?: SharedBufferSource;
        config?: PayloadBufferOptions;
    };
    /**
     * @deprecated Use `payload.sab`.
     */
    sab?: SharedBufferSource;
    /**
     * @deprecated Use `payload.config`.
     */
    payloadConfig?: PayloadBufferOptions;
    headersBuffer: Uint32Array;
    headerSlotStrideU32?: number;
    textCompat?: LockBufferTextCompat;
    host?: true;
}) => (task: Task, slotIndex: number, specialFlags?: number) => void;
