import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../../", import.meta.url));
const include = process.env.NODE_INCLUDE_DIR ??
  resolve(dirname(process.execPath), "../include/node");
if (!existsSync(resolve(include, "node.h"))) {
  throw new Error(
    "Set NODE_INCLUDE_DIR to headers matching the Node running this script.",
  );
}
if (!["linux", "darwin"].includes(process.platform)) {
  throw new Error("This small prototype build supports Linux/macOS only.");
}
const output = resolve(
  root,
  "build/Release/knitting_string_reference_bench.node",
);
mkdirSync(dirname(output), { recursive: true });
execFileSync(process.env.CXX ?? "c++", [
  "-std=c++20",
  "-O3",
  "-shared",
  "-fPIC",
  "-pthread",
  `-I${include}`,
  "-DNODE_GYP_MODULE_NAME=knitting_string_reference_bench",
  ...(process.platform === "darwin" ? ["-undefined", "dynamic_lookup"] : []),
  resolve(root, "bench/native/string-reference.cc"),
  "-o",
  output,
], { stdio: "inherit" });
console.log(`Built ${output} for Node ${process.versions.node}`);

const napiOutput = resolve(
  root,
  "build/Release/knitting_string_reference_napi.node",
);
execFileSync(process.env.CXX ?? "c++", [
  "-std=c++20",
  "-O3",
  "-shared",
  "-fPIC",
  "-pthread",
  `-I${include}`,
  ...(process.platform === "darwin" ? ["-undefined", "dynamic_lookup"] : []),
  resolve(root, "bench/native/string-reference-napi.cc"),
  "-o",
  napiOutput,
], { stdio: "inherit" });
console.log(`Built ${napiOutput} (Node-API, shared by Node/Deno/Bun)`);
