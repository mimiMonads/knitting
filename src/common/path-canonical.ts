import {
  existsSyncCompat,
  pathBasename,
  pathDirname,
  pathJoin,
  pathResolve,
  realpathSyncCompat,
} from "./node-compat.ts";

type CanonicalPathFsApi = {
  existsSync?: (candidate: string) => boolean;
  realpathSync?: (candidate: string) => string;
};

export const toCanonicalPath = (
  candidate: string,
  fsApi: CanonicalPathFsApi = {
    existsSync: existsSyncCompat,
    realpathSync: realpathSyncCompat,
  },
): string => {
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
