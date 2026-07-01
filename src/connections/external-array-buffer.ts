type DetachableArrayBuffer = ArrayBuffer & {
  transfer?: (newByteLength?: number) => ArrayBuffer;
  transferToFixedLength?: (newByteLength?: number) => ArrayBuffer;
};

export const detachExternalArrayBuffer = (buffer: ArrayBuffer): boolean => {
  if (buffer.byteLength === 0) return true;

  const detachable = buffer as DetachableArrayBuffer;
  try {
    if (typeof detachable.transferToFixedLength === "function") {
      detachable.transferToFixedLength(0);
      return buffer.byteLength === 0;
    }
  } catch {
  }

  try {
    if (typeof detachable.transfer === "function") {
      detachable.transfer(0);
      return buffer.byteLength === 0;
    }
  } catch {
  }

  try {
    structuredClone(buffer, { transfer: [buffer] });
    return buffer.byteLength === 0;
  } catch {
    return false;
  }
};

export const requireDetachedExternalArrayBuffer = (
  buffer: ArrayBuffer,
): void => {
  if (detachExternalArrayBuffer(buffer)) return;
  throw new Error(
    "knitting: could not detach external ArrayBuffer; refusing to unmap memory still reachable from JavaScript",
  );
};
