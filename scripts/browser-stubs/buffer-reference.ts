// Browser stub for `src/connections/buffer-reference.ts`.
//
// A BufferReference is an FFI pointer, so a page can neither build nor receive
// one: the real class already throws there. With none in flight the two
// hot-path helpers keep their meaning — nothing to release, nothing to read.
export const BUFFER_REFERENCE_NUMERIC_TRANSFER = Symbol.for(
  "knitting.bufferReference.numericTransfer",
);
export const BUFFER_REFERENCE_RETURN_RELEASE_TOKEN = Symbol.for(
  "knitting.bufferReference.returnReleaseToken",
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

export const withBufferReferenceReturnReleaser = <T>(
  _releaser: unknown,
  run: () => T,
): T => run();

export const readBufferReferenceReturnReleaseMessage = (
  _value: unknown,
): undefined => undefined;

export const createBufferReferenceReturnReleaseMessage = unavailable;
export const detachArrayBufferBestEffort = unavailable;
