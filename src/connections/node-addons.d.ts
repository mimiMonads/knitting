type NodeRequire = (specifier: string) => unknown;
export type NodeNativeAddonName = "knitting_shared_memory" | "knitting_shm";
export declare const nodeNativeAddonSpecifiers: (name: NodeNativeAddonName) => readonly string[];
export declare const loadNodeNativeAddon: <T>(require: NodeRequire, name: NodeNativeAddonName, specifier?: string) => T;
export {};
