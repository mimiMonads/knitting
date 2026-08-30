export {
  BUFFER_REFERENCE_CODEC_ID,
  BUFFER_REFERENCE_KIND,
  BufferReference,
  type BufferReferenceMetadata,
  BufferReferenceReturn,
  type BufferReferenceRuntime,
  isBufferReferenceMetadata,
} from "./src/connections/buffer-reference.ts";

export {
  drainSharedReturnReleases,
  sharedBytes,
  sharedReturnPoolStats,
} from "./src/worker/shared-return.ts";
