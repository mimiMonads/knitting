import { type SharedBufferSource } from "./shared-buffer-region.js";
export type SharedBufferTextCompat = {
    encodeInto: boolean;
    decode: boolean;
};
export type LockBufferTextCompat = {
    headers: SharedBufferTextCompat;
    payload: SharedBufferTextCompat;
};
export declare const isSharedBufferTextCompat: (value: unknown) => value is SharedBufferTextCompat;
export declare const isLockBufferTextCompat: (value: unknown) => value is LockBufferTextCompat;
export declare const probeSharedBufferTextCompat: (source: SharedBufferSource) => SharedBufferTextCompat;
export declare const probeLockBufferTextCompat: ({ headers, payload, }: {
    headers: SharedBufferSource;
    payload: SharedBufferSource;
}) => LockBufferTextCompat;
