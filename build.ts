//@ts-ignore
await Bun.build({
  entrypoints: ["./knitting.ts"],
  outdir: "./out",
  format: "esm",
  target: "node",
});
