export type SharedBuffer = SharedArrayBuffer | ArrayBuffer;
export type SharedBufferRegion = {
    sab: SharedBuffer;
    byteOffset: number;
    byteLength: number;
};
export type SharedBufferSource = SharedBuffer | SharedBufferRegion;
export declare const isSharedBuffer: (value: unknown) => value is SharedBuffer;
export declare const isSharedBufferRegion: (value: unknown) => value is SharedBufferRegion;
export declare const isSharedBufferSource: (value: unknown) => value is SharedBufferSource;
export declare const toSharedBufferRegion: (value: SharedBufferSource) => SharedBufferRegion;
