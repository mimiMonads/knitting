import { getNodeBuiltinModule, getNodeProcess } from "../common/node-compat.ts";
import { resolveKnittingPackageAsset } from "./package-assets.ts";

export type NativeStrings = {
  retain(text: string): bigint;
  clone(token: bigint): bigint;
  describe(token: bigint): { length: number; byteLength: number };
  adopt(token: bigint): string;
  release(token: bigint): boolean;
  stats(): {
    entries: number;
    liveBytes: number;
    externalAdoptions: number;
    copiedAdoptions: number;
  };
};
let addon: NativeStrings | undefined;
/** Loaded only when a reference is constructed or received. Node-API is ABI stable. */
export function getNativeStrings(): NativeStrings {
  if (addon) return addon;
  const process = getNodeProcess();
  const module = getNodeBuiltinModule<typeof import("node:module")>(
    "node:module",
  );
  const fs = getNodeBuiltinModule<typeof import("node:fs")>("node:fs");
  const arch = getNodeBuiltinModule<typeof import("node:os")>("node:os")
    ?.arch();
  if (!process || !module || !fs || !arch) {
    throw new Error("StringReference requires Node-compatible native addons");
  }
  const require = module.createRequire(import.meta.url);
  const prebuilds = resolveKnittingPackageAsset("prebuilds");
  const prefix = `${process.platform}-${arch}-node-`;
  let directories: string[] = [];
  try {
    directories = fs.readdirSync(prebuilds).filter((entry) =>
      entry.startsWith(prefix)
    );
  } catch {}
  const paths = [
    resolveKnittingPackageAsset(
      "prebuilds",
      `${prefix}${process.versions?.modules}`,
      "knitting_string_reference.node",
    ),
    ...directories.map((dir) =>
      resolveKnittingPackageAsset(
        "prebuilds",
        dir,
        "knitting_string_reference.node",
      )
    ),
    resolveKnittingPackageAsset(
      "build",
      "Release",
      "knitting_string_reference.node",
    ),
  ];
  let cause: unknown;
  for (const path of paths) {
    try {
      return addon = require(path) as NativeStrings;
    } catch (error) {
      cause = error;
    }
  }
  throw new Error(
    "Experimental StringReference requires its native addon. Run npm run build:native and enable native addons/FFI in workers.",
    { cause },
  );
}
