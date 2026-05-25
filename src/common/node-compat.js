const nodeProcess = (() => {
    const candidate = globalThis
        .process;
    return typeof candidate?.versions?.node === "string" ? candidate : undefined;
})();
export const getNodeProcess = () => nodeProcess;
export const getNodeBuiltinModule = (specifier) => {
    const getter = nodeProcess?.getBuiltinModule;
    if (typeof getter !== "function")
        return undefined;
    try {
        return getter.call(nodeProcess, specifier);
    }
    catch {
    }
    if (!specifier.startsWith("node:"))
        return undefined;
    try {
        return getter.call(nodeProcess, specifier.slice(5));
    }
    catch {
        return undefined;
    }
};
