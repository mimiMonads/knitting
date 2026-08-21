// Shared by `build-browser.ts` and `test-browser.ts` so the bundle under test
// is the bundle that ships.
//
// Each entry replaces a Node-only subtree a page can never reach. A stale stub
// fails the build: the bundler cannot find the export its importer wants.
import { dirname, join, resolve } from "node:path";

export type BunPlugin = {
  name: string;
  setup: (build: {
    onResolve: (
      options: { filter: RegExp },
      callback: (
        args: { path: string; importer: string },
      ) => { path: string } | undefined,
    ) => void;
  }) => void;
};

const stubDirectory = resolve(import.meta.dirname ?? ".");
const root = resolve(stubDirectory, "..", "..");

const stubbed: Record<string, string> = {
  "src/connections/buffer-reference.ts": "buffer-reference.ts",
  "src/connections/buffer-reference-native.ts": "buffer-reference-native.ts",
  "src/connections/process-shared-buffer.ts": "process-shared-buffer.ts",
  "src/permission/index.ts": "permission.ts",
  "src/runtime/compiled-artifact.ts": "compiled-artifact.ts",
  "src/runtime/compiled-worker.ts": "compiled-worker.ts",
  "src/runtime/process-worker.ts": "process-worker.ts",
  "src/worker/process-worker-bootstrap.ts": "process-worker-bootstrap.ts",
};

const stubs = new Map(
  Object.entries(stubbed).map((
    [source, stub],
  ) => [join(root, source), join(stubDirectory, stub)]),
);

export const browserStubPlugin: BunPlugin = {
  name: "knitting-browser-stubs",
  setup: (build) => {
    build.onResolve({ filter: /\.ts$/ }, (args) => {
      if (!args.path.startsWith(".") || args.importer === "") return undefined;
      const stub = stubs.get(resolve(dirname(args.importer), args.path));
      return stub === undefined ? undefined : { path: stub };
    });
  },
};
