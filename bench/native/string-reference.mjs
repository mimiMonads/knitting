import { createRequire } from "node:module";
import process from "node:process";
export const stringBackend = process.env.STRING_BACKEND ??
  (globalThis.Bun || globalThis.Deno ? "napi" : "v8");
if (!["napi", "v8"].includes(stringBackend)) {
  throw new Error("STRING_BACKEND must be napi or v8");
}
export const nativeStrings = createRequire(import.meta.url)(
  stringBackend === "v8"
    ? "../../build/Release/knitting_string_reference_bench.node"
    : "../../build/Release/knitting_string_reference_napi.node",
);
