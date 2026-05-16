import {
  HAS_SAB_GROW,
  isGrowableSharedArrayBuffer,
  sharedArrayBufferMaxByteLength,
} from "../common/runtime.ts";
import {
  type SharedBufferSource,
  toSharedBufferRegion,
} from "../common/shared-buffer-region.ts";

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

type PayloadBackingBuffer = SharedArrayBuffer | ArrayBuffer;

const canGrowSharedBuffer = (sab: PayloadBackingBuffer | undefined): boolean => {
  if (sab == null) return false;
  return sab instanceof SharedArrayBuffer &&
    HAS_SAB_GROW &&
    isGrowableSharedArrayBuffer(sab);
};

const sharedBufferMaxByteLength = (
  sab: PayloadBackingBuffer | undefined,
): number | undefined => {
  if (sab == null) return undefined;
  if (sab instanceof SharedArrayBuffer) {
    return toPositiveInteger(sharedArrayBufferMaxByteLength(sab));
  }
  return toPositiveInteger(sab.byteLength);
};

export const resolvePayloadBufferOptions = ({
  options,
  sab,
}: {
  options?: PayloadBufferOptions;
  sab?: PayloadBackingBuffer | SharedBufferSource;
}): ResolvedPayloadBufferOptions => {
  const sabRegion = sab === undefined ? undefined : toSharedBufferRegion(sab);
  const backing = sabRegion?.sab;
  const requestedMode = options?.mode;
  const modeDefault: PayloadBufferMode = HAS_SAB_GROW ? "growable" : "fixed";
  let mode: PayloadBufferMode = requestedMode ?? modeDefault;
  if (mode === "growable" && backing != null && !canGrowSharedBuffer(backing)) {
    mode = "fixed";
  }
  if (mode === "growable" && !HAS_SAB_GROW) {
    mode = "fixed";
  }

  const payloadMaxByteLength =
    toPositiveInteger(options?.payloadMaxByteLength) ??
    toPositiveInteger(sabRegion?.byteLength) ??
    sharedBufferMaxByteLength(backing) ??
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
