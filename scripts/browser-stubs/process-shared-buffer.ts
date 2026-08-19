// Browser stub for `src/connections/process-shared-buffer.ts`.
//
// Named shared memory is an OS handle from FFI, so no value in a page can be a
// ProcessSharedBuffer: the guard answers false and the constructors throw.
// Dropping this drops the bun/deno/node primitives and the FFI beneath them.
export const isProcessSharedBufferValue = (_value: unknown): boolean => false;

const unavailable = (): never => {
  throw new Error("ProcessSharedBuffer is unavailable in the browser build");
};

export class ProcessSharedBuffer {
  constructor() {
    unavailable();
  }
  static create = unavailable;
  static fromMetadata = unavailable;
  toMetadata = unavailable;
}

export const getDefaultProcessSharedBufferPrimitives = unavailable;
export const setDefaultProcessSharedBufferPrimitives = (): void => {};
