import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const safeExists = (path: string): boolean => {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
};

const safeIsDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const moduleDirectory = (moduleUrl: string): string => {
  const path = fileURLToPath(moduleUrl);
  return safeIsDirectory(path) ? path : dirname(path);
};

const isKnittingPackageRoot = (dir: string): boolean =>
  safeExists(join(dir, "package.json")) &&
  (safeExists(join(dir, "prebuilds")) ||
    safeExists(join(dir, "src")) ||
    safeExists(join(dir, "build")));

let cachedPackageRoot: string | undefined;

export const findKnittingPackageRoot = (
  moduleUrl = import.meta.url,
): string => {
  if (cachedPackageRoot !== undefined) return cachedPackageRoot;

  let current = moduleDirectory(moduleUrl);
  while (true) {
    if (isKnittingPackageRoot(current)) {
      cachedPackageRoot = current;
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `Could not locate knitting package root from ${moduleUrl}`,
      );
    }
    current = parent;
  }
};

export const resolveKnittingPackageAsset = (
  ...segments: string[]
): string => join(findKnittingPackageRoot(), ...segments);
