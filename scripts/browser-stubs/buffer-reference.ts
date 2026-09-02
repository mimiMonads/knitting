// Browser stub for `src/connections/buffer-reference.ts`.
//
// A BufferReference is an FFI pointer, so a page can neither build nor receive
// one: the real class already throws there. With none in flight the two
// hot-path helpers keep their meaning — nothing to release, nothing to read.
export const BUFFER_REFERENCE_NUMERIC_TRANSFER = Symbol.for(
  "knitting.bufferReference.numericTransfer",
);

const unavailable = (): never => {
  throw new Error('BufferReference cannot run in runtime "browser"');
};

export class BufferReference {
  constructor() {
    unavailable();
  }
  static fromMetadata = unavailable;
}

export const isBufferReferenceValue = (_value: unknown): boolean => false;

export const detachArrayBufferBestEffort = unavailable;

// A page has no way to move a buffer, so the codec never reaches its move path
// and never asks. `byteLength === 0` is the same heuristic the real
// implementation falls back to when a runtime has no `detached` getter.
export const isArrayBufferDetached = (buffer: ArrayBuffer): boolean =>
  buffer.byteLength === 0;
