export type SharedBuffer = SharedArrayBuffer | ArrayBuffer;

export type SharedBufferRegion = {
  sab: SharedBuffer;
  byteOffset: number;
  byteLength: number;
};

export type SharedBufferSource = SharedBuffer | SharedBufferRegion;

export const isSharedBuffer = (value: unknown): value is SharedBuffer =>
  value instanceof SharedArrayBuffer || value instanceof ArrayBuffer;

export const isSharedBufferRegion = (
  value: unknown,
): value is SharedBufferRegion => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SharedBufferRegion>;
  return isSharedBuffer(candidate.sab) &&
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
  isSharedBuffer(value) || isSharedBufferRegion(value);

export const toSharedBufferRegion = (
  value: SharedBufferSource,
): SharedBufferRegion =>
  isSharedBuffer(value)
    ? {
      sab: value,
      byteOffset: 0,
      byteLength: value.byteLength,
    }
    : value;
