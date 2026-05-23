type NodeRequire = (specifier: string) => unknown;

export type NodeNativeAddonName =
  | "knitting_shared_memory"
  | "knitting_shm";

type NodePlatformInfo = {
  arch: string;
  modules?: string;
  platform: string;
};

const readNodePlatformInfo = (): NodePlatformInfo | undefined => {
  const processLike = (globalThis as typeof globalThis & {
    process?: {
      platform?: string;
      arch?: string;
      versions?: { modules?: string };
    };
  }).process;
  if (
    typeof processLike?.platform !== "string" ||
    typeof processLike.arch !== "string"
  ) {
    return undefined;
  }
  return {
    arch: processLike.arch,
    modules: processLike.versions?.modules,
    platform: processLike.platform,
  };
};

export const nodeNativeAddonSpecifiers = (
  name: NodeNativeAddonName,
): readonly string[] => {
  const platformInfo = readNodePlatformInfo();
  const fallback = `../../build/Release/${name}.node`;
  if (platformInfo === undefined) return [fallback];

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

export const loadNodeNativeAddon = <T>(
  require: NodeRequire,
  name: NodeNativeAddonName,
  specifier?: string,
): T => {
  if (specifier !== undefined) return require(specifier) as T;

  const errors: string[] = [];
  for (const candidate of nodeNativeAddonSpecifiers(name)) {
    try {
      return require(candidate) as T;
    } catch (error) {
      errors.push(`${candidate}: ${String(error)}`);
    }
  }

  throw new Error(
    `Could not load native addon ${name}. Tried:\n${errors.join("\n")}`,
  );
};
