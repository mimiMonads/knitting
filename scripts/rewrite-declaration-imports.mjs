import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const roots = ["knitting.d.ts", "process-shared-buffer.d.ts", "unsafe.d.ts", "src"];
const importExtensionPattern = /\.ts(?=["')])/g;

const rewriteFile = (filePath) => {
  const source = readFileSync(filePath, "utf8");
  const next = source.replace(importExtensionPattern, ".js");
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
  }
};

for (const root of roots) {
  visit(root);
}
