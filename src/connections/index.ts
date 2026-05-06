export {
  alignToCacheLine,
  CACHE_LINE_SIZE,
  type ConnectionRuntime,
  type CreateSharedMemoryOptions,
  expectFd,
  expectPositiveSize,
  type MapSharedMemoryOptions,
  requireSharedArrayBuffer,
  type SharedMemoryBuffer,
  type SharedMemoryBufferKind,
  type SharedMemoryConnectionPrimitives,
  type SharedMemoryMapping,
} from "./types.ts";
export {
  FileDescriptor,
  type FileDescriptorMetadata,
  parseFileDescriptorMetadata,
} from "./file-descriptor.ts";
