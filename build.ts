import { rmSync } from "node:fs";

declare const Bun: {
  build: (options: {
    entrypoints: string[];
    outdir: string;
    format: "esm";
    target: "node";
    external?: string[];
  }) => Promise<{ success: boolean; logs: unknown[] }>;
};

const entrypoints = [
  "./knitting.ts",
  "./shared-memory.ts",
  "./unsafe.ts",
  "./utils.ts",
];

for (const staleOutput of [
  "./process-shared-buffer.d.ts",
  "./process-shared-buffer.js",
]) {
  rmSync(staleOutput, { force: true });
}

const result = await Bun.build({
  entrypoints,
  outdir: ".",
  format: "esm",
  target: "node",
  external: ["node:*"],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
