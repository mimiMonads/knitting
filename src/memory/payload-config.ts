import { HAS_SAB_GROW } from "../common/runtime.ts";

export const PAYLOAD_DEFAULT_MAX_BYTE_LENGTH = 64 * 1024 * 1024;
export const PAYLOAD_DEFAULT_INITIAL_BYTES = 4 * 1024 * 1024;

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

const toPositiveInteger = (value: number | undefined): number | undefined => {
  if (!Number.isFinite(value)) return undefined;
  const int = Math.floor(value as number);
  return int > 0 ? int : undefined;
};

const canGrowSharedBuffer = (sab: SharedArrayBuffer | undefined): boolean => {
  if (sab == null) return false;
  const value = sab as SharedArrayBuffer & { grow?: unknown; growable?: unknown };
  return HAS_SAB_GROW &&
    typeof value.grow === "function" &&
    value.growable === true;
};

const sharedBufferMaxByteLength = (
  sab: SharedArrayBuffer | undefined,
): number | undefined => {
  if (sab == null) return undefined;

  const max = (sab as SharedArrayBuffer & { maxByteLength?: unknown })
    .maxByteLength;
  if (typeof max === "number") {
    const sanitized = toPositiveInteger(max);
    if (sanitized !== undefined) return sanitized;
  }

  return toPositiveInteger(sab.byteLength);
};

export const resolvePayloadBufferOptions = ({
  options,
  sab,
}: {
  options?: PayloadBufferOptions;
  sab?: SharedArrayBuffer;
}): ResolvedPayloadBufferOptions => {
  const requestedMode = options?.mode;
  const modeDefault: PayloadBufferMode = HAS_SAB_GROW ? "growable" : "fixed";
  let mode: PayloadBufferMode = requestedMode ?? modeDefault;
  if (mode === "growable" && sab != null && !canGrowSharedBuffer(sab)) {
    mode = "fixed";
  }
  if (mode === "growable" && !HAS_SAB_GROW) {
    mode = "fixed";
  }

  const payloadMaxByteLength =
    toPositiveInteger(options?.payloadMaxByteLength) ??
    sharedBufferMaxByteLength(sab) ??
    PAYLOAD_DEFAULT_MAX_BYTE_LENGTH;

  const requestedInitialBytes = toPositiveInteger(options?.payloadInitialBytes);
  const payloadInitialBytes = mode === "fixed"
    ? payloadMaxByteLength
    : Math.min(
      requestedInitialBytes ?? PAYLOAD_DEFAULT_INITIAL_BYTES,
      payloadMaxByteLength,
    );

  const maxPayloadCeiling = payloadMaxByteLength >> 3;
  if (maxPayloadCeiling <= 0) {
    throw new RangeError(
      "payloadMaxByteLength is too small; must be at least 8 bytes.",
    );
  }

  const rawMaxPayloadBytes = options?.maxPayloadBytes;
  if (rawMaxPayloadBytes !== undefined) {
    const normalized = Math.floor(rawMaxPayloadBytes);
    if (!Number.isFinite(normalized) || normalized <= 0) {
      throw new RangeError(
        `maxPayloadBytes must be > 0 and <= ${maxPayloadCeiling}.`,
      );
    }
  }

  const maxPayloadBytes =
    toPositiveInteger(rawMaxPayloadBytes) ?? maxPayloadCeiling;
  if (maxPayloadBytes <= 0 || maxPayloadBytes > maxPayloadCeiling) {
    throw new RangeError(
      `maxPayloadBytes must be > 0 and <= ${maxPayloadCeiling}.`,
    );
  }

  return {
    mode,
    payloadInitialBytes,
    payloadMaxByteLength,
    maxPayloadBytes,
  };
};
