import { getNodeBuiltinModule } from "../common/node-compat.ts";

// `node:` builtins resolved lazily so this module evaluates on runtimes without
// them (Andromeda); these helpers only run on FFI/native asset paths.
type FsModule = {
  existsSync: (path: string) => boolean;
  statSync: (path: string) => { isDirectory: () => boolean };
};
type PathModule = {
  dirname: (path: string) => string;
  join: (...segments: string[]) => string;
};
type UrlModule = { fileURLToPath: (url: string) => string };

let fsModule: FsModule | undefined;
let pathModule: PathModule | undefined;
let urlModule: UrlModule | undefined;

const requireNode = <T>(value: T | undefined, specifier: string): T => {
  if (value === undefined) {
    throw new Error(`${specifier} is not available in this runtime`);
  }
  return value;
};

const fs = (): FsModule =>
  requireNode(
    fsModule ??= getNodeBuiltinModule<FsModule>("node:fs"),
    "node:fs",
  );
const path = (): PathModule =>
  requireNode(
    pathModule ??= getNodeBuiltinModule<PathModule>("node:path"),
    "node:path",
  );
const url = (): UrlModule =>
  requireNode(
    urlModule ??= getNodeBuiltinModule<UrlModule>("node:url"),
    "node:url",
  );

const safeExists = (target: string): boolean => {
  try {
    return fs().existsSync(target);
  } catch {
    return false;
  }
};

const safeIsDirectory = (target: string): boolean => {
  try {
    return fs().statSync(target).isDirectory();
  } catch {
    return false;
  }
};

const moduleDirectory = (moduleUrl: string): string => {
  const target = url().fileURLToPath(moduleUrl);
  return safeIsDirectory(target) ? target : path().dirname(target);
};

const isKnittingPackageRoot = (dir: string): boolean =>
  safeExists(path().join(dir, "package.json")) &&
  (safeExists(path().join(dir, "prebuilds")) ||
    safeExists(path().join(dir, "src")) ||
    safeExists(path().join(dir, "build")));

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

    const parent = path().dirname(current);
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
): string => path().join(findKnittingPackageRoot(), ...segments);
