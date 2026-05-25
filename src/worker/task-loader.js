var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { endpointSymbol } from "../common/task-symbol.js";
import { toModuleUrl } from "../common/module-url.js";
const normalizeTimeout = (timeout) => {
    if (timeout == null)
        return undefined;
    if (typeof timeout === "number") {
        const ms = Math.floor(timeout);
        return ms >= 0
            ? { ms, kind: 0 /* TimeoutKind.Reject */, value: new Error("Task timeout") }
            : undefined;
    }
    const ms = Math.floor(timeout.time);
    if (!(ms >= 0))
        return undefined;
    if ("default" in timeout) {
        return { ms, kind: 1 /* TimeoutKind.Resolve */, value: timeout.default };
    }
    if (timeout.maybe === true) {
        return { ms, kind: 1 /* TimeoutKind.Resolve */, value: undefined };
    }
    if ("error" in timeout) {
        return { ms, kind: 0 /* TimeoutKind.Reject */, value: timeout.error };
    }
    return { ms, kind: 0 /* TimeoutKind.Reject */, value: new Error("Task timeout") };
};
const composeWorkerCallable = (fixed, _permission) => {
    return fixed.f;
};
export const getFunctions = async ({ list, ids, at, permission }) => {
    const modules = list.map((specifier) => toModuleUrl(specifier));
    const results = await Promise.all(modules.map(async (imports) => {
        const module = (await import(__rewriteRelativeImportExtension(imports)));
        return Object.entries(module)
            .filter(([_, value]) => value != null && typeof value === "object" &&
            //@ts-ignore Reason -> trust me
            value?.[endpointSymbol] === true)
            .map(([name, value]) => ({
            //@ts-ignore Reason -> trust me
            ...value,
            name,
        }));
    }));
    // Flatten the results, filter by IDs, and sort
    const flattened = results.flat();
    const useAtFilter = modules.length === 1 && at.length > 0;
    const atSet = useAtFilter ? new Set(at) : null;
    const targetModule = useAtFilter ? modules[0] : null;
    const flattenedResults = flattened
        .filter((obj) => useAtFilter
        ? obj.importedFrom === targetModule && atSet.has(obj.at)
        : ids.includes(obj.id))
        .sort((a, b) => a.name.localeCompare(b.name));
    return flattenedResults.map((fixed) => ({
        ...fixed,
        run: composeWorkerCallable(fixed, permission),
        timeout: normalizeTimeout(fixed.timeout),
    }));
};
