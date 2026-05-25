export const isSharedBuffer = (value) => value instanceof SharedArrayBuffer || value instanceof ArrayBuffer;
export const isSharedBufferRegion = (value) => {
    if (!value || typeof value !== "object")
        return false;
    const candidate = value;
    return isSharedBuffer(candidate.sab) &&
        typeof candidate.byteOffset === "number" &&
        Number.isInteger(candidate.byteOffset) &&
        candidate.byteOffset >= 0 &&
        typeof candidate.byteLength === "number" &&
        Number.isInteger(candidate.byteLength) &&
        candidate.byteLength >= 0;
};
export const isSharedBufferSource = (value) => isSharedBuffer(value) || isSharedBufferRegion(value);
export const toSharedBufferRegion = (value) => isSharedBuffer(value)
    ? {
        sab: value,
        byteOffset: 0,
        byteLength: value.byteLength,
    }
    : value;
