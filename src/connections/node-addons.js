const readNodePlatformInfo = () => {
    const processLike = globalThis.process;
    if (typeof processLike?.platform !== "string" ||
        typeof processLike.arch !== "string") {
        return undefined;
    }
    return {
        arch: processLike.arch,
        modules: processLike.versions?.modules,
        platform: processLike.platform,
    };
};
export const nodeNativeAddonSpecifiers = (name) => {
    const platformInfo = readNodePlatformInfo();
    const fallback = `../../build/Release/${name}.node`;
    if (platformInfo === undefined)
        return [fallback];
    const nodeModuleAbi = platformInfo.modules;
    if (typeof nodeModuleAbi === "string" && nodeModuleAbi.length > 0) {
        return [
            `../../prebuilds/${platformInfo.platform}-${platformInfo.arch}-node-${nodeModuleAbi}/${name}.node`,
            fallback,
        ];
    }
    return [
        `../../prebuilds/${platformInfo.platform}-${platformInfo.arch}/${name}.node`,
        fallback,
    ];
};
export const loadNodeNativeAddon = (require, name, specifier) => {
    if (specifier !== undefined)
        return require(specifier);
    const errors = [];
    for (const candidate of nodeNativeAddonSpecifiers(name)) {
        try {
            return require(candidate);
        }
        catch (error) {
            errors.push(`${candidate}: ${String(error)}`);
        }
    }
    throw new Error(`Could not load native addon ${name}. Tried:\n${errors.join("\n")}`);
};
