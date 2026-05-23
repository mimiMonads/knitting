import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

declare const Bun: {
  env: Record<string, string | undefined>;
  spawnSync: (options: {
    cmd: string[];
    stdout?: "pipe";
    stderr?: "pipe";
  }) => {
    exitCode: number;
    stdout: Uint8Array;
    stderr: Uint8Array;
  };
};

type NodeInfo = {
  arch: string;
  execPath: string;
  nodedir: string | null;
  platform: string;
  version: string;
};

const textDecode = new TextDecoder();
const root = resolve(import.meta.dirname ?? ".", "..");
const outDir = join(root, "build", "Release");
const nodeBinary = Bun.env.NODE_BINARY ?? "node";

const splitFlags = (value: string | undefined): string[] =>
  value?.split(/\s+/).filter(Boolean) ?? [];

const runCapture = (cmd: string, args: string[]): string => {
  const result = Bun.spawnSync({
    cmd: [cmd, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    const stderr = textDecode.decode(result.stderr).trim();
    throw new Error(`${cmd} ${args.join(" ")} failed\n${stderr}`);
  }

  return textDecode.decode(result.stdout).trim();
};

const run = (cmd: string, args: string[]): void => {
  console.log(`$ ${[cmd, ...args].join(" ")}`);
  const result = Bun.spawnSync({
    cmd: [cmd, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = textDecode.decode(result.stdout);
  const stderr = textDecode.decode(result.stderr);
  if (stdout.length > 0) console.log(stdout.trimEnd());
  if (stderr.length > 0) console.error(stderr.trimEnd());

  if (result.exitCode !== 0) {
    throw new Error(`${cmd} exited with code ${result.exitCode}`);
  }
};

const nodeInfo = JSON.parse(runCapture(nodeBinary, [
  "-p",
  "JSON.stringify({arch:process.arch,execPath:process.execPath,nodedir:process.config.variables.nodedir||null,platform:process.platform,version:process.versions.node})",
])) as NodeInfo;
const isWindows = nodeInfo.platform === "win32";
const cacheRoot = join(
  resolve(
    Bun.env.KNITTING_NODE_CACHE_DIR ??
      Bun.env.RUNNER_TEMP ??
      Bun.env.TEMP ??
      Bun.env.TMPDIR ??
      tmpdir(),
  ),
  "knitting-node",
);

const downloadFile = async (url: string, outputPath: string): Promise<void> => {
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Download failed (${response.status} ${response.statusText}): ${url}`,
    );
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, new Uint8Array(await response.arrayBuffer()));
};

const ensureDownloadedNodeHeaders = async (): Promise<string> => {
  const version = `v${nodeInfo.version}`;
  const headersRoot = join(cacheRoot, "headers", version);
  const headersDir = join(
    headersRoot,
    `node-${version}`,
    "include",
    "node",
  );

  if (existsSync(join(headersDir, "node.h"))) {
    return headersDir;
  }

  const archive = join(headersRoot, `node-${version}-headers.tar.gz`);
  if (!existsSync(archive)) {
    await downloadFile(
      `https://nodejs.org/download/release/${version}/node-${version}-headers.tar.gz`,
      archive,
    );
  }

  mkdirSync(headersRoot, { recursive: true });
  run("tar", ["-xzf", archive, "-C", headersRoot]);

  if (!existsSync(join(headersDir, "node.h"))) {
    throw new Error(`Downloaded Node headers did not contain ${headersDir}`);
  }

  return headersDir;
};

const nodeLibDownloadArch = (arch: string): string => {
  if (arch === "x64" || arch === "arm64") return arch;
  if (arch === "ia32") return "x86";
  throw new Error(`Unsupported Windows Node architecture: ${arch}`);
};

const ensureDownloadedNodeLib = async (): Promise<string> => {
  const version = `v${nodeInfo.version}`;
  const arch = nodeLibDownloadArch(nodeInfo.arch);
  const nodeLib = join(cacheRoot, "lib", version, `win-${arch}`, "node.lib");

  if (!existsSync(nodeLib)) {
    await downloadFile(
      `https://nodejs.org/download/release/${version}/win-${arch}/node.lib`,
      nodeLib,
    );
  }

  return nodeLib;
};

const includeCandidates = [
  Bun.env.NODE_INCLUDE_DIR,
  nodeInfo.nodedir ? join(nodeInfo.nodedir, "include", "node") : undefined,
  join(dirname(dirname(nodeInfo.execPath)), "include", "node"),
  join(dirname(nodeInfo.execPath), "..", "include", "node"),
  "/usr/include/node",
  "/usr/local/include/node",
].filter((value): value is string => typeof value === "string");

let includeDir = includeCandidates.find((candidate) =>
  existsSync(join(candidate, "node.h"))
);

if (includeDir === undefined) {
  includeDir = await ensureDownloadedNodeHeaders();
}

const nodeLibCandidates = isWindows
  ? [
    Bun.env.NODE_LIB_FILE,
    join(dirname(nodeInfo.execPath), "node.lib"),
    join(dirname(dirname(nodeInfo.execPath)), "node.lib"),
    join(dirname(dirname(nodeInfo.execPath)), "lib", "node.lib"),
    nodeInfo.nodedir
      ? join(nodeInfo.nodedir, "Release", "node.lib")
      : undefined,
    nodeInfo.nodedir
      ? join(nodeInfo.nodedir, nodeInfo.arch, "node.lib")
      : undefined,
    nodeInfo.nodedir ? join(nodeInfo.nodedir, "x64", "node.lib") : undefined,
    nodeInfo.nodedir ? join(nodeInfo.nodedir, "ia32", "node.lib") : undefined,
  ].filter((value): value is string => typeof value === "string")
  : [];
let nodeLib = isWindows
  ? nodeLibCandidates.find((candidate) => existsSync(candidate))
  : undefined;

if (isWindows && nodeLib === undefined) {
  nodeLib = await ensureDownloadedNodeLib();
}

mkdirSync(outDir, { recursive: true });

const cxx = Bun.env.CXX ??
  (isWindows ? "cl" : nodeInfo.platform === "darwin" ? "c++" : "g++");
const compileFlags = isWindows
  ? [
    "/nologo",
    "/std:c++20",
    "/O2",
    "/EHsc",
    "/LD",
    `/I${includeDir}`,
    ...splitFlags(Bun.env.CXXFLAGS),
  ]
  : [
    "-std=c++20",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Wno-unused-parameter",
    "-Wno-cast-function-type",
    "-fPIC",
    `-I${includeDir}`,
    ...splitFlags(Bun.env.CXXFLAGS),
  ];
const linkFlags = nodeInfo.platform === "darwin"
  ? ["-bundle", "-undefined", "dynamic_lookup"]
  : isWindows
  ? []
  : ["-shared"];
const extraLdFlags = splitFlags(Bun.env.LDFLAGS);

const addons = [
  {
    name: "knitting_shared_memory",
    source: "src/knitting_shared_memory.cc",
    output: "build/Release/knitting_shared_memory.node",
  },
  {
    name: "knitting_shm",
    source: "src/knitting_shm.cc",
    output: "build/Release/knitting_shm.node",
  },
];
const prebuildDir = join(
  root,
  "prebuilds",
  `${nodeInfo.platform}-${nodeInfo.arch}`,
);

console.log(`Using Node: ${nodeInfo.execPath}`);
console.log(`Using headers: ${includeDir}`);
console.log(`Using compiler: ${cxx}`);
if (nodeLib !== undefined) console.log(`Using node.lib: ${nodeLib}`);

const builtAddons: string[] = [];
const copiedPrebuilds: string[] = [];

for (const addon of addons) {
  const outputPath = join(root, addon.output);
  if (isWindows) {
    run(cxx, [
      ...compileFlags,
      join(root, addon.source),
      "/link",
      `/OUT:${outputPath}`,
      nodeLib!,
      ...extraLdFlags,
    ]);
  } else {
    run(cxx, [
      ...compileFlags,
      ...linkFlags,
      ...extraLdFlags,
      "-o",
      outputPath,
      join(root, addon.source),
    ]);
  }
  builtAddons.push(addon.output);

  mkdirSync(prebuildDir, { recursive: true });
  const prebuildPath = join(prebuildDir, `${addon.name}.node`);
  copyFileSync(outputPath, prebuildPath);
  copiedPrebuilds.push(prebuildPath);
}

console.log(
  `Built ${builtAddons.length} native addon${
    builtAddons.length === 1 ? "" : "s"
  } ` +
    `for ${nodeInfo.platform}: ${builtAddons.join(", ")}`,
);
console.log(
  `Updated ${copiedPrebuilds.length} prebuild${
    copiedPrebuilds.length === 1 ? "" : "s"
  } in ${prebuildDir}`,
);
