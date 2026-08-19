// End-to-end browser checks. Serves the library cross-origin isolated
// (SharedArrayBuffer needs that), drives headless Chromium at it, and compares
// the report the page posts back. Two topologies:
//
//   bundled     everything in one app bundle, the way a bundler ships an app
//   standalone  the emitted single-file `knitting.browser.js` plus a separate
//               task module, the way a plain script tag loads it
//
//   bun run scripts/test-browser.ts
//
// Skips instead of failing when no Chromium-family browser is installed; set
// KNITTING_CHROMIUM to point at one explicitly.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserStubPlugin, type BunPlugin } from "./browser-stubs/plugin.ts";

declare const Bun: {
  build: (options: {
    entrypoints: string[];
    target: "browser";
    plugins?: BunPlugin[];
  }) => Promise<{
    success: boolean;
    logs: unknown[];
    outputs: { text: () => Promise<string> }[];
  }>;
  serve: (options: {
    port: number;
    fetch: (request: Request) => Response | Promise<Response>;
  }) => { port: number; stop: () => void };
  spawn: (
    command: string[],
    options?: { stdout?: "ignore"; stderr?: "ignore" },
  ) => { kill: () => void; exited: Promise<number> };
};

const root = resolve(import.meta.dirname ?? ".", "..");
const REPORT_TIMEOUT_MS = 90_000;

const findBrowser = (): string | undefined => {
  const candidates = [
    process.env.KNITTING_CHROMIUM,
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
  ];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return undefined;
};

const browser = findBrowser();
if (browser === undefined) {
  console.log(
    "skipping browser tests: no Chromium-family browser found " +
      "(set KNITTING_CHROMIUM to override)",
  );
  process.exit(0);
}

const bundle = async (entry: string): Promise<string> => {
  const built = await Bun.build({
    entrypoints: [join(root, entry)],
    target: "browser",
    plugins: [browserStubPlugin],
  });
  if (!built.success) {
    for (const log of built.logs) console.error(log);
    throw new Error(`browser bundle failed: ${entry}`);
  }
  return await built.outputs[0]!.text();
};

const html = (entry: string) =>
  `<!doctype html><html><body><script type="module" src="${entry}"></script>` +
  "</body></html>";

// Cross-origin isolation is what makes `SharedArrayBuffer` reachable; without
// these two headers the page cannot construct one at all.
const headers = (type: string) => ({
  "Content-Type": type,
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
});

const contentType = (path: string) =>
  path.endsWith(".js") ? "text/javascript" : "text/html";

type Scenario = {
  name: string;
  routes: Record<string, string>;
  expected: Record<string, unknown>;
};

const runScenario = async (scenario: Scenario): Promise<boolean> => {
  let resolveReport: (value: Record<string, unknown>) => void;
  const reported = new Promise<Record<string, unknown>>((resolve) => {
    resolveReport = resolve;
  });

  const server = Bun.serve({
    port: 0,
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/report") {
        resolveReport(await request.json() as Record<string, unknown>);
        return new Response("thanks", { headers: headers("text/plain") });
      }
      const body = scenario.routes[path];
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(body, { headers: headers(contentType(path)) });
    },
  });

  const profile = mkdtempSync(join(tmpdir(), "knitting-browser-"));
  const child = Bun.spawn([
    browser,
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    // Keeps the run offline: sign-in and update chatter costs minutes.
    "--disable-background-networking",
    `--user-data-dir=${profile}`,
    `http://localhost:${server.port}/`,
  ], { stdout: "ignore", stderr: "ignore" });

  let report: Record<string, unknown>;
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("the page never reported within 90s")),
        REPORT_TIMEOUT_MS,
      )
    );
    report = await Promise.race([reported, timeout]);
  } finally {
    child.kill();
    server.stop();
    rmSync(profile, { recursive: true, force: true });
  }

  console.log(`\n${scenario.name}:`);
  if (report.fatal !== undefined) {
    console.error("  the pool never started: " + report.fatal);
    return false;
  }

  const failures: string[] = [];
  for (const [name, want] of Object.entries(scenario.expected)) {
    const got = report[name];
    const same = JSON.stringify(got) === JSON.stringify(want);
    console.log(`  ${same ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(got)}`);
    if (!same) failures.push(`${name}: expected ${JSON.stringify(want)}`);
  }
  return failures.length === 0;
};

const app = await bundle(join("test", "browser", "app.ts"));
const library = await bundle("knitting.browser.ts");
const standaloneTasks = readFileSync(
  join(root, "test", "browser", "standalone-tasks.js"),
  "utf8",
);

const scenarios: Scenario[] = [
  {
    name: "bundled (tasks and library in one bundle)",
    routes: { "/": html("/app.js"), "/app.js": app },
    expected: {
      single: 49,
      string: "hello browser",
      object: { sum: 2, tag: "X" },
      bytes: [2, 3, 4],
      // Sum of squares below 200.
      parallel: 2646700,
      // `spin` returns -1 only when it observed the abort bit flip.
      abort: -1,
      shutdown: "ok",
    },
  },
  {
    name: "standalone (single-file bundle plus a task module)",
    routes: {
      "/": html("/tasks.js"),
      "/tasks.js": standaloneTasks,
      "/knitting.browser.js": library,
    },
    expected: {
      single: 49,
      string: "hello browser",
      // Sum of squares below 50.
      parallel: 40425,
      shutdown: "ok",
    },
  },
];

let ok = true;
for (const scenario of scenarios) {
  if (!await runScenario(scenario)) ok = false;
}

if (!ok) {
  console.error("\nbrowser checks failed");
  process.exit(1);
}

console.log("\nall browser checks passed");
process.exit(0);
