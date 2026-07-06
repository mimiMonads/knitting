import { getNodeBuiltinModule } from "./node-compat.ts";
import { IS_ANDROMEDA } from "./runtime.ts";

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH = /^\\\\[^\\/?]+\\[^\\/?]+/;

const encodeFilePath = (path: string) =>
  encodeURI(path)
    .replace(/\?/g, "%3F")
    .replace(/#/g, "%23");

// `node:url` resolved lazily (absent on Andromeda); fall back to a pure
// path->file-URL conversion when it is missing.
const nodePathToFileURL = (): ((p: string) => URL) | undefined =>
  getNodeBuiltinModule<{ pathToFileURL?: (p: string) => URL }>("node:url")
    ?.pathToFileURL;

const pathToFileUrlFallback = (specifier: string): string => {
  const absolute = specifier.startsWith("/") ? specifier : `/${specifier}`;
  return `file://${encodeFilePath(absolute)}`;
};

export const toModuleUrl = (specifier: string): string => {
  if (WINDOWS_DRIVE_PATH.test(specifier)) {
    const normalized = specifier.replace(/\\/g, "/");
    return `file:///${encodeFilePath(normalized)}`;
  }

  if (WINDOWS_UNC_PATH.test(specifier)) {
    const normalized = specifier
      .replace(/^\\\\+/, "")
      .replace(/\\/g, "/");
    return `file://${encodeFilePath(normalized)}`;
  }

  try {
    return new URL(specifier).href;
  } catch {
    const pathToFileURL = nodePathToFileURL();
    return pathToFileURL
      ? pathToFileURL(specifier).href
      : pathToFileUrlFallback(specifier);
  }
};

// Andromeda's loader treats `file://` import specifiers as relative paths;
// convert back to a plain filesystem path there. No-op elsewhere.
export const toImportSpecifier = (moduleUrl: string): string => {
  if (!IS_ANDROMEDA || !moduleUrl.startsWith("file://")) return moduleUrl;
  const withoutScheme = moduleUrl.slice("file://".length);
  const path = withoutScheme.startsWith("/")
    ? withoutScheme
    : `/${withoutScheme}`;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};
