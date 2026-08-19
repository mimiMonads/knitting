// Browser stub for `src/connections/buffer-reference-native.ts`.
//
// The real module throws this exact error for any runtime that is not Node,
// Deno, or Bun. Stubbing it drops the FFI tree only it reaches: node-ffi,
// windows, posix, node-addons.
export const getBufferReferenceCapabilities = (): never => {
  throw new Error('BufferReference cannot run in runtime "browser"');
};
