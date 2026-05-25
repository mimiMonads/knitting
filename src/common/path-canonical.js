import { existsSync, realpathSync, } from "node:fs";
import { basename as pathBasename, dirname as pathDirname, join as pathJoin, resolve as pathResolve, } from "node:path";
export const toCanonicalPath = (candidate, fsApi = {
    existsSync,
    realpathSync: realpathSync.native ?? realpathSync,
}) => {
    const absolute = pathResolve(candidate);
    const { existsSync, realpathSync } = fsApi;
    if (typeof realpathSync === "function") {
        try {
            return pathResolve(realpathSync(absolute));
        }
        catch {
        }
    }
    else {
        return absolute;
    }
    if (typeof existsSync !== "function")
        return absolute;
    const missingSegments = [];
    let cursor = absolute;
    while (!existsSync(cursor)) {
        const parent = pathDirname(cursor);
        if (parent === cursor)
            return absolute;
        missingSegments.push(pathBasename(cursor));
        cursor = parent;
    }
    let base = cursor;
    try {
        base = realpathSync(cursor);
    }
    catch {
    }
    let rebuilt = base;
    for (let i = missingSegments.length - 1; i >= 0; i--) {
        rebuilt = pathJoin(rebuilt, missingSegments[i]);
    }
    return pathResolve(rebuilt);
};
