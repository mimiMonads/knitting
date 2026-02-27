import path from "node:path";

type CanonicalPathFsApi = {
  existsSync?: (candidate: string) => boolean;
  realpathSync?: (candidate: string) => string;
};

export const toCanonicalPath = (
  candidate: string,
  fsApi: CanonicalPathFsApi = {},
): string => {
  const absolute = path.resolve(candidate);
  const { existsSync, realpathSync } = fsApi;

  if (typeof realpathSync === "function") {
    try {
      return path.resolve(realpathSync(absolute));
    } catch {
    }
  } else {
    return absolute;
  }

  if (typeof existsSync !== "function") return absolute;

  const missingSegments: string[] = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return absolute;
    missingSegments.push(path.basename(cursor));
    cursor = parent;
  }

  let base = cursor;
  try {
    base = realpathSync(cursor);
  } catch {
  }

  let rebuilt = base;
  for (let i = missingSegments.length - 1; i >= 0; i--) {
    rebuilt = path.join(rebuilt, missingSegments[i]!);
  }
  return path.resolve(rebuilt);
};
