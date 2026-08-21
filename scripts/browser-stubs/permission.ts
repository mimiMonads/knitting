// Browser stub for `src/permission/index.ts`.
//
// Permissions describe a filesystem, a process, and runtime flags, none of
// which a page has. `resolvePermissionProtocol` already short-circuits on
// IS_BROWSER, and the compatibility pair only runs for process workers.
export const resolvePermissionProtocol = (): undefined => undefined;

export const toRuntimePermissionFlags = (): string[] => [];

const unavailable = (): never => {
  throw new Error("process workers are unavailable in the browser build");
};

export const classifyProcessPermissionCompatibility = unavailable;
export const enforceProcessPermissionCompatibility = unavailable;
