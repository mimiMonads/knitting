import { getNodeBuiltinModule } from "./node-compat.ts";

// `node:fs`/`node:path` resolved lazily so this module evaluates on runtimes
// that lack them (e.g. Andromeda); only host-side canonicalization uses them.
type RealpathSync = ((candidate: string) => string) & {
  native?: (candidate: string) => string;
};
type FsModule = {
  existsSync: (candidate: string) => boolean;
  realpathSync: RealpathSync;
};
type PathModule = {
  basename: (path: string) => string;
  dirname: (path: string) => string;
  join: (...segments: string[]) => string;
  resolve: (...segments: string[]) => string;
};

const nodeFs = (): FsModule | undefined =>
  getNodeBuiltinModule<FsModule>("node:fs");

const nodePath = (): PathModule => {
  const module = getNodeBuiltinModule<PathModule>("node:path");
  if (module === undefined) {
    throw new Error("node:path is not available in this runtime");
  }
  return module;
};

type CanonicalPathFsApi = {
  existsSync?: (candidate: string) => boolean;
  realpathSync?: (candidate: string) => string;
};

const defaultFsApi = (): CanonicalPathFsApi => {
  const fs = nodeFs();
  if (fs === undefined) return {};
  return {
    existsSync: fs.existsSync,
    realpathSync: fs.realpathSync.native ?? fs.realpathSync,
  };
};

export const toCanonicalPath = (
  candidate: string,
  fsApi: CanonicalPathFsApi = defaultFsApi(),
): string => {
  const {
    basename: pathBasename,
    dirname: pathDirname,
    join: pathJoin,
    resolve: pathResolve,
  } = nodePath();
  const absolute = pathResolve(candidate);
  const { existsSync, realpathSync } = fsApi;

  if (typeof realpathSync === "function") {
    try {
      return pathResolve(realpathSync(absolute));
    } catch {
    }
  } else {
    return absolute;
  }

  if (typeof existsSync !== "function") return absolute;

  const missingSegments: string[] = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    const parent = pathDirname(cursor);
    if (parent === cursor) return absolute;
    missingSegments.push(pathBasename(cursor));
    cursor = parent;
  }

  let base = cursor;
  try {
    base = realpathSync(cursor);
  } catch {
  }

  let rebuilt = base;
  for (let i = missingSegments.length - 1; i >= 0; i--) {
    rebuilt = pathJoin(rebuilt, missingSegments[i]!);
  }
  return pathResolve(rebuilt);
};
