import { resolveKnittingPackageAsset } from "./package-assets.ts";

type NodeRequire = (specifier: string) => unknown;

export type NodeNativeAddonName =
  | "knitting_shared_memory"
  | "knitting_shm"
  | "knitting_buffer_pointer";

export type NodePlatformInfo = {
  arch: string;
  modules?: string;
  platform: string;
  version?: string;
};

export const SUPPORTED_NODE_NATIVE_ADDON_ABIS = {
  "127": "22",
  "137": "24",
} as const;

const NODE_26_MODULE_ABI = "147";
const SUPPORTED_NODE_NATIVE_TARGETS = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "win32-x64",
]);

const readNodePlatformInfo = (): NodePlatformInfo | undefined => {
  const processLike = (globalThis as typeof globalThis & {
    process?: {
      platform?: string;
      arch?: string;
      versions?: { modules?: string; node?: string };
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
    version: processLike.versions?.node,
  };
};

const formatAttemptErrors = (errors: readonly string[]): string =>
  errors.length > 0 ? `\nTried:\n${errors.join("\n")}` : "";

export const formatNodeNativeAddonLoadError = (
  name: NodeNativeAddonName,
  platformInfo: NodePlatformInfo | undefined,
  errors: readonly string[],
): string => {
  const attempts = formatAttemptErrors(errors);
  if (platformInfo === undefined) {
    return `knitting: could not load native addon ${name}.${attempts}`;
  }

  const abi = platformInfo.modules;
  const version = platformInfo.version === undefined
    ? "an unknown version"
    : `v${platformInfo.version}`;
  const target = `${platformInfo.platform}-${platformInfo.arch}`;

  if (abi === NODE_26_MODULE_ABI) {
    return (
      `knitting: Node.js 26 uses node:ffi instead of ABI-specific addons. ` +
      `Restart Node with the --experimental-ffi flag` +
      ` (--allow-ffi is also required when using Node's Permission Model). ` +
      `No Node ABI 147 addon is shipped.${attempts}`
    );
  }

  if (
    typeof abi === "string" &&
    !(abi in SUPPORTED_NODE_NATIVE_ADDON_ABIS)
  ) {
    return (
      `knitting: no native addon is shipped for Node.js ${version} ` +
      `(ABI ${abi}). Packaged native features support Node.js 22 ` +
      `(ABI 127) and Node.js 24 (ABI 137) only. Plain thread workers that do ` +
      `not use ProcessSharedBuffer or BufferReference do not need these ` +
      `addons.${attempts}`
    );
  }

  if (!SUPPORTED_NODE_NATIVE_TARGETS.has(target)) {
    return (
      `knitting: Node.js ${version} uses a supported ABI (${
        abi ?? "unknown"
      }), ` +
      `but no packaged native addon target is shipped for ${target}. ` +
      `Published targets are linux-x64, darwin-x64, darwin-arm64, and ` +
      `win32-x64. You can build locally with "bun run build:native".${attempts}`
    );
  }

  return (
    `knitting: could not load native addon ${name} for Node.js ${version} ` +
    `(ABI ${abi ?? "unknown"}, ${target}). The prebuild may be missing, ` +
    `damaged, or incompatible; reinstall the package or build locally with ` +
    `"bun run build:native".${attempts}`
  );
};

export const nodeNativeAddonSpecifiers = (
  name: NodeNativeAddonName,
): readonly string[] => {
  const platformInfo = readNodePlatformInfo();
  const fallback = resolveKnittingPackageAsset(
    "build",
    "Release",
    `${name}.node`,
  );
  if (platformInfo === undefined) return [fallback];

  const nodeModuleAbi = platformInfo.modules;
  if (typeof nodeModuleAbi === "string" && nodeModuleAbi.length > 0) {
    return [
      resolveKnittingPackageAsset(
        "prebuilds",
        `${platformInfo.platform}-${platformInfo.arch}-node-${nodeModuleAbi}`,
        `${name}.node`,
      ),
      fallback,
    ];
  }

  return [
    resolveKnittingPackageAsset(
      "prebuilds",
      `${platformInfo.platform}-${platformInfo.arch}`,
      `${name}.node`,
    ),
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
    formatNodeNativeAddonLoadError(name, readNodePlatformInfo(), errors),
  );
};
