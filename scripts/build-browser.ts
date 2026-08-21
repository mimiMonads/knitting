// Bundles the browser entry into one self-hosting module: the page loads it,
// and every web worker the pool spawns loads that same URL.
//
//   bun run scripts/build-browser.ts [--out dir] [--no-minify|--only-minified]
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { browserStubPlugin, type BunPlugin } from "./browser-stubs/plugin.ts";

declare const Bun: {
  build: (options: {
    entrypoints: string[];
    target: "browser";
    minify?: boolean;
    sourcemap?: "external" | "none";
    plugins?: BunPlugin[];
  }) => Promise<{
    success: boolean;
    logs: unknown[];
    outputs: { text: () => Promise<string> }[];
  }>;
};

const root = resolve(import.meta.dirname ?? ".", "..");
const entry = join(root, "knitting.browser.ts");

const readFlag = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const outDirectory = resolve(root, readFlag("--out") ?? "build");
const onlyMinified = process.argv.includes("--only-minified");
const skipMinified = process.argv.includes("--no-minify");

const bundle = async (minified: boolean): Promise<string> => {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    minify: minified,
    sourcemap: "none",
    plugins: [browserStubPlugin],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("browser bundle failed");
  }
  return await result.outputs[0]!.text();
};

const kb = (bytes: number) => (bytes / 1024).toFixed(1) + " KB";

// The package build takes `--only-minified`: one file, under the plain name,
// because that is the artifact consumers load.
const wanted = onlyMinified
  ? [{ file: "knitting.browser.js", minified: true }]
  : skipMinified
  ? [{ file: "knitting.browser.js", minified: false }]
  : [
    { file: "knitting.browser.js", minified: false },
    { file: "knitting.browser.min.js", minified: true },
  ];

mkdirSync(outDirectory, { recursive: true });

for (const { file, minified } of wanted) {
  const text = await bundle(minified);
  const path = join(outDirectory, file);
  writeFileSync(path, text);
  const gzipped = gzipSync(Buffer.from(text), { level: 9 }).byteLength;
  console.log(
    `${path}  ${kb(Buffer.byteLength(text))}  (${kb(gzipped)} gzipped)`,
  );
}
