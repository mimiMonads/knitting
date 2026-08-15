import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const generatedRootOutputs = [
  "knitting.d.ts",
  "knitting.js",
  "process-shared-buffer.d.ts",
  "process-shared-buffer.js",
  "shared-memory.d.ts",
  "shared-memory.js",
  "unsafe.d.ts",
  "unsafe.js",
  "utils.d.ts",
  "utils.js",
];

const removeGeneratedSourceOutputs = (dir: string): void => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      removeGeneratedSourceOutputs(path);
    } else if (path.endsWith(".js") || path.endsWith(".d.ts")) {
      rmSync(path, { force: true });
    }
  }
};

for (const output of generatedRootOutputs) {
  rmSync(output, { force: true });
}
removeGeneratedSourceOutputs("src");
