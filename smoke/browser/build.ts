import { rm } from "node:fs/promises";

const smokeOutdir = ".tmp/browser-smoke";
const appOutdir = `${smokeOutdir}/app`;
const packageOutdir = "out/browser";

await rm(smokeOutdir, { recursive: true, force: true });
await rm(packageOutdir, { recursive: true, force: true });

const packageBuild = await Bun.build({
  entrypoints: ["./knitting.ts"],
  outdir: packageOutdir,
  target: "browser",
  format: "esm",
});

if (!packageBuild.success) {
  for (const log of packageBuild.logs) {
    console.error(log);
  }
  throw new Error("Browser package bundle failed");
}

const appBuild = await Bun.build({
  entrypoints: ["./smoke/browser/smoke.ts"],
  outdir: appOutdir,
  target: "browser",
  format: "esm",
});

if (!appBuild.success) {
  for (const log of appBuild.logs) {
    console.error(log);
  }
  throw new Error("Browser smoke app bundle failed");
}
