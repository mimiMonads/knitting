type NodeRequire = (specifier: string) => unknown;

export type NodeNativeAddonName =
  | "knitting_shared_memory"
  | "knitting_shm";

const readNodePlatformArch = (): { platform: string; arch: string } | undefined => {
  const processLike = (globalThis as typeof globalThis & {
    process?: { platform?: string; arch?: string };
  }).process;
  if (
    typeof processLike?.platform !== "string" ||
    typeof processLike.arch !== "string"
  ) {
    return undefined;
  }
  return { platform: processLike.platform, arch: processLike.arch };
};

export const nodeNativeAddonSpecifiers = (
  name: NodeNativeAddonName,
): readonly string[] => {
  const platformArch = readNodePlatformArch();
  const fallback = `../../build/Release/${name}.node`;
  if (platformArch === undefined) return [fallback];

  return [
    `../../prebuilds/${platformArch.platform}-${platformArch.arch}/${name}.node`,
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
