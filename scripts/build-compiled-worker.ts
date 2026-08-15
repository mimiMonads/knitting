#!/usr/bin/env bun
/// <reference types="bun" />

import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

type Options = {
  modulePath: string;
  outputPath: string;
  manifestPath: string;
  tasks: string[];
  compiler?: string;
};

const here = dirname(fileURLToPath(import.meta.url));
const runtime = resolve(here, "compiled-worker/runtime.ts");
const taskShim = resolve(here, "compiled-worker/task-shim.ts");
const repositoryEntry = resolve(here, "../knitting.ts");
const PORFFOR_REPOSITORY = "https://github.com/CanadaHonk/porffor.git";
const PORFFOR_REVISION = "747d551844750fc5ed32cf88cdf0b3854aee267e";

const usage = (): never => {
  console.error(
    "Usage: bun scripts/build-compiled-worker.ts --module tasks.ts " +
      "--out tasks.knt --tasks taskA,taskB [--porf /path/to/porf]",
  );
  process.exit(2);
};

const readOptions = (): Options => {
  const args = process.argv.slice(2);
  let modulePath: string | undefined;
  let outputPath: string | undefined;
  let manifestPath: string | undefined;
  let tasks: string[] | undefined;
  let compiler: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    const value = args[index + 1];
    if (value === undefined) usage();
    if (argument === "--module") modulePath = value;
    else if (argument === "--out") outputPath = value;
    else if (argument === "--manifest") manifestPath = value;
    else if (argument === "--tasks") tasks = value.split(",").filter(Boolean);
    else if (argument === "--porf") compiler = value;
    else usage();
    index++;
  }
  if (modulePath === undefined || outputPath === undefined || !tasks?.length) {
    usage();
  }
  for (const name of tasks) {
    if (!/^[$A-Z_a-z][$\w]*$/.test(name) && name !== "default") {
      throw new Error("Compiled task name is not an export identifier: " + name);
    }
  }
  return {
    modulePath: resolve(modulePath),
    outputPath: resolve(outputPath),
    manifestPath: manifestPath === undefined
      ? resolve(outputPath) + ".json"
      : resolve(manifestPath),
    tasks,
    compiler,
  };
};

const commandWorks = (command: string): boolean => {
  try {
    const result = Bun.spawnSync([command, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return result.exitCode === 0 &&
      new TextDecoder().decode(result.stdout).startsWith("alpha ");
  } catch {
    return false;
  }
};

const compilerPath = (input: string): string => {
  const decoded = input.startsWith("file:") ? fileURLToPath(input) : input;
  const path = decoded.includes("/") || decoded.includes("\\")
    ? resolve(decoded)
    : decoded;
  return existsSync(path) && statSync(path).isDirectory()
    ? join(path, "porf")
    : path;
};

const installCompiler = (): string => {
  const cacheRoot = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  const cache = join(
    cacheRoot,
    "knitting",
    "porffor-" + PORFFOR_REVISION.slice(0, 12),
  );
  const executable = join(cache, "porf");
  if (commandWorks(executable)) return executable;

  const temporary = cache + ".tmp-" + process.pid;
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true });
  const commands = [
    ["git", "-C", temporary, "init", "--quiet"],
    ["git", "-C", temporary, "remote", "add", "origin", PORFFOR_REPOSITORY],
    [
      "git",
      "-C",
      temporary,
      "fetch",
      "--quiet",
      "--depth",
      "1",
      "origin",
      PORFFOR_REVISION,
    ],
    ["git", "-C", temporary, "checkout", "--quiet", "--detach", "FETCH_HEAD"],
  ];
  console.error("Knitting: downloading the pinned Porffor compiler (first run only)");
  try {
    for (const command of commands) {
      const result = Bun.spawnSync(command, { stdout: "inherit", stderr: "inherit" });
      if (result.exitCode !== 0) {
        throw new Error(command[0] + " exited with code " + result.exitCode);
      }
    }
    rmSync(cache, { recursive: true, force: true });
    renameSync(temporary, cache);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  if (!commandWorks(executable)) {
    throw new Error("Downloaded Porffor compiler is unavailable");
  }
  return executable;
};

const resolveCompiler = (options: Options): string => {
  const configured = options.compiler ?? process.env.PORFFOR_MAIN ??
    process.env.PORF;
  if (configured !== undefined) {
    const candidate = compilerPath(configured);
    if (!commandWorks(candidate)) {
      throw new Error("Porffor main compiler is unavailable: " + candidate);
    }
    return candidate;
  }
  if (commandWorks("porf")) return "porf";
  return installCompiler();
};

const quote = (value: string): string => JSON.stringify(value);

const makeEntry = (modulePath: string, tasks: string[]): string => {
  const imports = tasks.map((name, index) =>
    name === "default"
      ? `import __knitExport${index} from ${quote(modulePath)};`
      : `import { ${name} as __knitExport${index} } from ${quote(modulePath)};`
  );
  const functions = tasks.map((_, index) =>
    `typeof __knitExport${index} === "function" ` +
    `? __knitExport${index} : __knitExport${index}.f`
  );
  return [
    ...imports,
    `import { runJsonWorker } from ${quote(runtime)};`,
    `runJsonWorker([${functions.join(", ")}]);`,
    "",
  ].join("\n");
};

const resolvesToKnitting = (specifier: string, resolveDir: string): boolean => {
  if (specifier === "knitting" || specifier === "@vixeny/knitting") return true;
  if (!specifier.startsWith(".") && !isAbsolute(specifier)) return false;
  const candidate = resolve(resolveDir, specifier).replace(/\.(?:js|ts)$/, "");
  return candidate === repositoryEntry.replace(/\.ts$/, "");
};

const run = async (): Promise<void> => {
  const options = readOptions();
  const outputDirectory = dirname(options.outputPath);
  const workDirectory = join(outputDirectory, ".knitting-compiled");
  const entryPath = join(workDirectory, "entry.ts");
  const bundlePath = join(workDirectory, "worker.bundle.js");
  mkdirSync(workDirectory, { recursive: true });
  mkdirSync(dirname(options.manifestPath), { recursive: true });
  await Bun.write(entryPath, makeEntry(options.modulePath, options.tasks));

  const build = await Bun.build({
    entrypoints: [entryPath],
    format: "esm",
    target: "browser",
    minify: { syntax: true, whitespace: false, identifiers: false },
    plugins: [{
      name: "knitting-compiled-worker-api",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) =>
          resolvesToKnitting(args.path, args.resolveDir)
            ? { path: taskShim }
            : undefined
        );
      },
    }],
  });
  if (!build.success || build.outputs[0] === undefined) {
    for (const log of build.logs) console.error(log);
    throw new Error("Bun could not bundle the compiled worker");
  }
  await Bun.write(bundlePath, build.outputs[0]);

  const porf = resolveCompiler(options);
  const versionResult = Bun.spawnSync([porf, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const version = new TextDecoder().decode(versionResult.stdout).trim();
  console.error("Knitting: compiling " + relative(process.cwd(), options.modulePath));
  const compilerEnvironment = { ...process.env };
  if (process.platform === "linux" && compilerEnvironment.CC === undefined) {
    compilerEnvironment.CC = "cc -Wno-stringop-overflow";
  }
  const compile = Bun.spawnSync([
    porf,
    "native",
    "--module",
    "--quiet",
    "-O3",
    "--flto=auto",
    bundlePath,
    "-o",
    options.outputPath,
  ], {
    stdout: "inherit",
    stderr: "inherit",
    env: compilerEnvironment,
  });
  if (compile.exitCode !== 0) {
    throw new Error("Porffor exited with code " + compile.exitCode);
  }
  chmodSync(options.outputPath, 0o755);

  await Bun.write(
    options.manifestPath,
    JSON.stringify({
      format: "knitting-compiled-worker",
      version: 1,
      protocol: "knitting-json-v1",
      compiler: { name: "porffor", version },
      target: { platform: process.platform, arch: process.arch },
      source: relative(outputDirectory, options.modulePath).replaceAll("\\", "/"),
      sourceMtimeMs: statSync(options.modulePath).mtimeMs,
      capabilities: { input: "json", output: "json", async: false },
      tasks: options.tasks.map((exportName, index) => ({ index, exportName })),
    }, null, 2) + "\n",
  );
  rmSync(workDirectory, { recursive: true, force: true });
};

await run();
