declare const Bun: {
  build: (options: {
    entrypoints: string[];
    outdir: string;
    format: "esm";
    target: "node";
  }) => Promise<{ success: boolean; logs: unknown[] }>;
};

const result = await Bun.build({
  entrypoints: ["./knitting.ts"],
  outdir: "./out",
  format: "esm",
  target: "node",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
