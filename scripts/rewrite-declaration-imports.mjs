import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const roots = [
  "knitting.d.ts",
  "process-shared-buffer.d.ts",
  "shared-memory.d.ts",
  "unsafe.d.ts",
  "utils.d.ts",
  "src",
];
const importExtensionPattern = /\.ts(?=["')])/g;
// tsc's `rewriteRelativeImportExtensions` rewrites dynamic imports for CommonJS
// output only; under ESM it leaves `import("./x.ts")` pointing at a file that is
// never published. Only relative `import()` literals are touched: other `.ts`
// strings in emitted JS (stack-frame markers, the compiled-worker builder path)
// are intentional.
const dynamicImportPattern =
  /(\bimport\(\s*["'])(\.{1,2}\/[^"']+)\.ts(["']\s*\))/g;

const rewriteFile = (filePath) => {
  const source = readFileSync(filePath, "utf8");
  const next = source.replace(importExtensionPattern, ".js");
  if (next !== source) {
    writeFileSync(filePath, next);
  }
};

const rewriteDynamicImports = (filePath) => {
  const source = readFileSync(filePath, "utf8");
  const next = source.replace(dynamicImportPattern, "$1$2.js$3");
  if (next !== source) {
    writeFileSync(filePath, next);
  }
};

const visit = (path) => {
  const stats = statSync(path);
  if (stats.isDirectory()) {
    for (const entry of readdirSync(path)) {
      visit(join(path, entry));
    }
    return;
  }

  if (path.endsWith(".d.ts")) {
    rewriteFile(path);
  } else if (path.endsWith(".js")) {
    rewriteDynamicImports(path);
  }
};

for (const root of roots) {
  visit(root);
}
