export {
  resolvePermissionProtocol,
  toRuntimePermissionFlags,
} from "./protocol.ts";

// Type-only re-exports are erased at runtime; exclude from runtime coverage.
/* c8 ignore start */
export type {
  PermissionPath,
  PermissionMode,
  PermissionLegacyMode,
  SysApiName,
  NodePermissionSettings,
  DenoPermissionSettings,
  PermissionEnvironment,
  PermissionProtocol,
  PermissionProtocolInput,
  ResolvedPermissionProtocol,
} from "./protocol.ts";
/* c8 ignore end */
