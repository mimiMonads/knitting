// Browser stub for `src/runtime/compiled-artifact.ts`. Reading a `.knt`
// artifact means reading a file, which a page cannot do.
export const inspectCompiledWorkerArtifact = (): never => {
  throw new Error(
    "compiled worker artifacts are unavailable in the browser build",
  );
};
