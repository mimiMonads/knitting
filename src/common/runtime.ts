type RuntimeName = "deno" | "bun" | "node" | "unknown";

type GlobalWithRuntimes = typeof globalThis & {
  Deno?: { version?: { deno?: string } };
  Bun?: { version?: string };
};

const globals = globalThis as GlobalWithRuntimes;

export const IS_DENO = typeof globals.Deno?.version?.deno === "string";
export const IS_BUN = typeof globals.Bun?.version === "string";
export const IS_NODE =
  typeof process !== "undefined" && typeof process.versions?.node === "string";

export const RUNTIME = (
  IS_DENO ? "deno" : IS_BUN ? "bun" : IS_NODE ? "node" : "unknown"
) as RuntimeName;
