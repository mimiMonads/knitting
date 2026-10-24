#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpus, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { renderMarkdown, summarize } from "./release-comparison/report.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const options = {
  baseline: "latest",
  repetitions: 5,
  iterations: 300,
  warmup: 50,
  memoryBuffers: 128,
  skipBuild: false,
};
const help = `Usage: node scripts/compare-release.mjs [options]
  --baseline VERSION_OR_TAG  Published knitting version/tag (default: latest)
  --repetitions N            Independent runs per version (default: 5)
  --iterations N             Measured operations per case/run (default: 300)
  --warmup N                 Warmup operations per case (default: 50)
  --memory-buffers N         Fresh 1 MiB returns per run (default: 128, max: 512)
  --output DIRECTORY         New artifact directory (default: results/release-comparison/TIMESTAMP-PID)
  --skip-build               Package the existing local build; caller must build JS and native code first

Builds the local release, resolves the published version once, saves both tarballs,
and installs them in temporary isolated directories with lifecycle scripts disabled.
Requires Node 22/24 with a supported native prebuild, npm, Bun, and a C++ compiler.
Correctness failures exit nonzero; performance changes are informational.
`;
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (flag === "--help" || flag === "-h") {
    console.log(help);
    process.exit(0);
  }
  if (flag === "--skip-build") {
    options.skipBuild = true;
    continue;
  }
  const key = {
    "--baseline": "baseline",
    "--repetitions": "repetitions",
    "--iterations": "iterations",
    "--warmup": "warmup",
    "--memory-buffers": "memoryBuffers",
    "--output": "output",
  }[flag];
  if (!key || process.argv[i + 1] === undefined) {
    throw new Error(`Invalid option: ${flag}\n${help}`);
  }
  const value = process.argv[++i];
  options[key] = ["baseline", "output"].includes(key) ? value : Number(value);
}
if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(options.baseline)) {
  throw new Error("baseline must be an npm version or tag");
}
for (
  const [key, maximum] of Object.entries({
    repetitions: 30,
    iterations: 100000,
    warmup: 100000,
    memoryBuffers: 512,
  })
) {
  if (
    !Number.isSafeInteger(options[key]) || options[key] < 1 ||
    options[key] > maximum
  ) throw new Error(`${key} must be between 1 and ${maximum}`);
}
const output = resolve(
  root,
  options.output ??
    join(
      "results",
      "release-comparison",
      `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${process.pid}`,
    ),
);
mkdirSync(dirname(output), { recursive: true });
mkdirSync(output); // Refuse to overwrite results from a previous run.
for (const directory of ["packages", "logs", "runs"]) {
  mkdirSync(join(output, directory));
}
const npmCli = [
  process.env.npm_execpath,
  join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
  join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
]
  .find((candidate) =>
    candidate?.endsWith("npm-cli.js") && existsSync(candidate)
  );
const git = (args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
};
const metadata = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  options,
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    cpu: cpus()[0]?.model,
    cpuCount: cpus().length,
  },
  git: {
    commit: git(["rev-parse", "HEAD"]),
    dirty: Boolean(git(["status", "--porcelain"])),
    status: git(["status", "--short"]),
  },
  scope: "single Node thread worker, trusted permissions, sequential calls",
};
const runs = [];
const save = () => {
  writeFileSync(
    join(output, "metadata.json"),
    JSON.stringify(metadata, null, 2) + "\n",
  );
  const summary = { ...summarize(runs, options.repetitions), runs };
  if (metadata.error) summary.complete = false;
  writeFileSync(
    join(output, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  const columns = [
    "name",
    "unit",
    "publishedRuns",
    "localRuns",
    "publishedMedianNs",
    "localMedianNs",
    "publishedP99Ns",
    "localP99Ns",
    "changePercent",
  ];
  writeFileSync(
    join(output, "summary.csv"),
    columns.join(",") + "\n" +
      summary.rows.map((row) => columns.map((key) => row[key] ?? "").join(","))
        .join("\n") +
      "\n",
  );
  writeFileSync(join(output, "report.md"), renderMarkdown(metadata, runs));
};
const command = (name, executable, args, cwd = root) => {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 20 * 1024 * 1024,
  });
  writeFileSync(
    join(output, "logs", `${name}.stdout.log`),
    result.stdout ?? "",
  );
  writeFileSync(
    join(output, "logs", `${name}.stderr.log`),
    result.stderr ?? "",
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `${name} failed (${
        result.error?.message ?? result.signal ?? result.status
      }); see logs/${name}.stderr.log`,
    );
  }
  return result.stdout;
};
const npm = (name, args, cwd) => {
  if (!npmCli) {
    throw new Error(
      "Cannot locate npm-cli.js; run through npm run bench:compare",
    );
  }
  return command(name, process.execPath, [npmCli, ...args], cwd);
};
const fingerprint = (path) => {
  const bytes = readFileSync(path);
  return {
    file: `packages/${path.split(/[\\/]/).pop()}`,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
  };
};
const requiredCases = [
  "warm_scalar",
  "reused_shared_1mib",
  "fresh_shared_1mib",
  "copied_bytes_1mib",
  "mapping_4kib",
];
const validate = (result) => {
  if (result?.ok !== true) {
    throw new Error(result?.error ?? "workload did not report success");
  }
  for (const name of requiredCases) {
    const samples = result.benchmarks?.[name]?.samplesNs;
    if (
      !Array.isArray(samples) || samples.length !== options.iterations ||
      samples.some((value) => !Number.isFinite(value) || value < 0)
    ) throw new Error(`Invalid samples: ${name}`);
  }
  if (
    !result.memory?.after || result.memory.buffers !== options.memoryBuffers ||
    result.correctness.length < 5
  ) throw new Error("Incomplete correctness or memory results");
};
let workspace;
save();
console.log(`Artifacts: ${output}`);
try {
  console.log(`Resolving knitting@${options.baseline}…`);
  const published = JSON.parse(
    npm("resolve-published", [
      "view",
      `knitting@${options.baseline}`,
      "version",
      "dist",
      "--json",
    ]),
  );
  if (
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(
      published.version,
    )
  ) throw new Error("Registry did not return an exact version");
  metadata.published = published;
  save();
  if (!options.skipBuild) {
    console.log("Building local JavaScript and native addons…");
    npm("build-local", ["run", "build:release"]);
  }
  const packDirectory = join(output, "packages");
  const localPack = JSON.parse(
    npm("pack-local", [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      packDirectory,
    ]),
  );
  const localTarball = join(packDirectory, localPack[0].filename);
  // Keep names separate even when published and local versions are identical.
  const renamedLocal = join(packDirectory, "local.tgz");
  copyFileSync(localTarball, renamedLocal);
  rmSync(localTarball);
  const publishedPack = JSON.parse(
    npm("pack-published", [
      "pack",
      `knitting@${published.version}`,
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      packDirectory,
    ]),
  );
  const publishedTarball = join(packDirectory, publishedPack[0].filename);
  metadata.local = {
    version: localPack[0].version,
    ...fingerprint(renamedLocal),
  };
  metadata.published.package = fingerprint(publishedTarball);
  if (metadata.published.package.integrity !== published.dist.integrity) {
    throw new Error(
      "Published tarball integrity differs from registry metadata",
    );
  }
  metadata.git.afterBuild = git(["status", "--short"]);
  workspace = mkdtempSync(join(tmpdir(), "knitting-release-comparison-"));
  const template = readFileSync(
    new URL("./release-comparison/workload.mjs", import.meta.url),
    "utf8",
  );
  writeFileSync(join(output, "packages", "workload.template.mjs"), template);
  metadata.workloadSha256 = createHash("sha256").update(template).digest("hex");
  const entries = {};
  for (
    const [variant, tarball] of [["local", renamedLocal], [
      "published",
      publishedTarball,
    ]]
  ) {
    const directory = join(workspace, variant);
    mkdirSync(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    npm(`install-${variant}`, [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--omit=dev",
      "--save-exact",
      tarball,
    ], directory);
    copyFileSync(
      join(directory, "package-lock.json"),
      join(output, "packages", `${variant}.package-lock.json`),
    );
    const installed = join(directory, "node_modules", "knitting");
    const workload = template.replace(
      "__KNITTING_ENTRY__",
      pathToFileURL(join(installed, "knitting.js")).href,
    )
      .replace(
        "__KNITTING_SHARED__",
        pathToFileURL(join(installed, "shared-memory.js")).href,
      );
    entries[variant] = join(directory, "workload.mjs");
    writeFileSync(entries[variant], workload);
    copyFileSync(
      entries[variant],
      join(output, "packages", `${variant}.workload.mjs`),
    );
  }
  for (let repetition = 1; repetition <= options.repetitions; repetition++) {
    const order = repetition % 2
      ? ["published", "local"]
      : ["local", "published"];
    for (const variant of order) {
      console.log(
        `${variant}: repetition ${repetition}/${options.repetitions}`,
      );
      const stem = `${variant}-${repetition}`;
      const jsonFile = join(output, "runs", `${stem}.json`);
      const outcome = spawnSync(process.execPath, [
        "--expose-gc",
        entries[variant],
        jsonFile,
        String(options.iterations),
        String(options.warmup),
        String(options.memoryBuffers),
        String(repetition - 1),
      ], {
        cwd: dirname(entries[variant]),
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 20 * 1024 * 1024,
      });
      writeFileSync(
        join(output, "runs", `${stem}.stdout.log`),
        outcome.stdout ?? "",
      );
      writeFileSync(
        join(output, "runs", `${stem}.stderr.log`),
        outcome.stderr ?? "",
      );
      const run = {
        variant,
        repetition,
        status: "failed",
        exitCode: outcome.status,
        signal: outcome.signal,
        artifact: `runs/${stem}.json`,
      };
      try {
        if (existsSync(jsonFile)) {
          run.result = JSON.parse(readFileSync(jsonFile, "utf8"));
        }
        if (outcome.error || outcome.status !== 0) {
          throw new Error(
            outcome.error?.message ??
              `workload exited with ${
                outcome.signal ?? outcome.status
              }; see runs/${stem}.stderr.log`,
          );
        }
        validate(run.result);
        run.status = "passed";
      } catch (error) {
        run.error = error.message;
      }
      runs.push(run);
      save();
    }
  }
} catch (error) {
  metadata.error = error.stack ?? String(error);
  console.error(error.message);
} finally {
  metadata.finishedAt = new Date().toISOString();
  save();
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}
const passed = !metadata.error && summarize(runs, options.repetitions).complete;
console.log(`${passed ? "Passed" : "Failed"}: ${join(output, "report.md")}`);
process.exitCode = passed ? 0 : 1;
