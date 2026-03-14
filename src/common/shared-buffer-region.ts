export type SharedBufferRegion = {
  sab: SharedArrayBuffer;
  byteOffset: number;
  byteLength: number;
};

export type SharedBufferSource = SharedArrayBuffer | SharedBufferRegion;

export const isSharedBufferRegion = (
  value: unknown,
): value is SharedBufferRegion => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SharedBufferRegion>;
  return candidate.sab instanceof SharedArrayBuffer &&
    typeof candidate.byteOffset === "number" &&
    Number.isInteger(candidate.byteOffset) &&
    candidate.byteOffset >= 0 &&
    typeof candidate.byteLength === "number" &&
    Number.isInteger(candidate.byteLength) &&
    candidate.byteLength >= 0;
};

export const isSharedBufferSource = (
  value: unknown,
): value is SharedBufferSource =>
  value instanceof SharedArrayBuffer || isSharedBufferRegion(value);

export const toSharedBufferRegion = (
  value: SharedBufferSource,
): SharedBufferRegion =>
  value instanceof SharedArrayBuffer
    ? {
      sab: value,
      byteOffset: 0,
      byteLength: value.byteLength,
    }
    : value;
