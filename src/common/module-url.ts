import { pathToFileURL } from "node:url";

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH = /^\\\\[^\\/?]+\\[^\\/?]+/;

const encodeFilePath = (path: string) =>
  encodeURI(path)
    .replace(/\?/g, "%3F")
    .replace(/#/g, "%23");

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
    return pathToFileURL(specifier).href;
  }
};
