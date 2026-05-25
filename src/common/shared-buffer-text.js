import { toSharedBufferRegion, } from "./shared-buffer-region.js";
const textEncode = new TextEncoder();
const textDecode = new TextDecoder();
const isSharedBufferTextCompatTypeError = (error) => error instanceof TypeError;
const makeProbeView = (source) => {
    const region = toSharedBufferRegion(source);
    const probeLength = Math.min(1, region.byteLength);
    return new Uint8Array(region.sab, region.byteOffset, probeLength);
};
export const isSharedBufferTextCompat = (value) => {
    if (!value || typeof value !== "object")
        return false;
    const candidate = value;
    return typeof candidate.encodeInto === "boolean" &&
        typeof candidate.decode === "boolean";
};
export const isLockBufferTextCompat = (value) => {
    if (!value || typeof value !== "object")
        return false;
    const candidate = value;
    return isSharedBufferTextCompat(candidate.headers) &&
        isSharedBufferTextCompat(candidate.payload);
};
export const probeSharedBufferTextCompat = (source) => {
    const view = makeProbeView(source);
    const encodeInto = (() => {
        if (typeof textEncode.encodeInto !== "function")
            return false;
        const probe = view.byteLength > 0 ? view : view.subarray(0, 0);
        const restoredByte = probe.byteLength > 0 ? probe[0] : undefined;
        try {
            textEncode.encodeInto(probe.byteLength > 0 ? "a" : "", probe);
            return true;
        }
        catch (error) {
            if (!isSharedBufferTextCompatTypeError(error))
                throw error;
            return false;
        }
        finally {
            if (restoredByte !== undefined) {
                probe[0] = restoredByte;
            }
        }
    })();
    const decode = (() => {
        try {
            textDecode.decode(view);
            return true;
        }
        catch (error) {
            if (!isSharedBufferTextCompatTypeError(error))
                throw error;
            return false;
        }
    })();
    return {
        encodeInto,
        decode,
    };
};
export const probeLockBufferTextCompat = ({ headers, payload, }) => ({
    headers: probeSharedBufferTextCompat(headers),
    payload: probeSharedBufferTextCompat(payload),
});
