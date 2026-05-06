import { existsSync, mkdirSync } from "node:fs";
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
  execPath: string;
  nodedir: string | null;
  platform: string;
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
  "JSON.stringify({execPath:process.execPath,nodedir:process.config.variables.nodedir||null,platform:process.platform})",
])) as NodeInfo;

const includeCandidates = [
  Bun.env.NODE_INCLUDE_DIR,
  nodeInfo.nodedir ? join(nodeInfo.nodedir, "include", "node") : undefined,
  join(dirname(dirname(nodeInfo.execPath)), "include", "node"),
  join(dirname(nodeInfo.execPath), "..", "include", "node"),
  "/usr/include/node",
  "/usr/local/include/node",
].filter((value): value is string => typeof value === "string");

const includeDir = includeCandidates.find((candidate) =>
  existsSync(join(candidate, "node.h"))
);

if (includeDir === undefined) {
  throw new Error(
    `Unable to find Node headers for ${nodeInfo.execPath}. ` +
      "Set NODE_INCLUDE_DIR=/path/to/include/node and retry.",
  );
}

mkdirSync(outDir, { recursive: true });

const cxx = Bun.env.CXX ?? (nodeInfo.platform === "darwin" ? "c++" : "g++");
const compileFlags = [
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
  : ["-shared"];
const extraLdFlags = splitFlags(Bun.env.LDFLAGS);

const addons = [
  {
    source: "src/knitting_shared_memory.cc",
    output: "build/Release/knitting_shared_memory.node",
  },
  {
    source: "src/knitting_shm.cc",
    output: "build/Release/knitting_shm.node",
  },
];

console.log(`Using Node: ${nodeInfo.execPath}`);
console.log(`Using headers: ${includeDir}`);
console.log(`Using compiler: ${cxx}`);

const builtAddons: string[] = [];

for (const addon of addons) {
  const outputPath = join(root, addon.output);
  run(cxx, [
    ...compileFlags,
    ...linkFlags,
    ...extraLdFlags,
    "-o",
    outputPath,
    join(root, addon.source),
  ]);
  builtAddons.push(addon.output);
}

console.log(
  `Built ${builtAddons.length} native addon${
    builtAddons.length === 1 ? "" : "s"
  } ` +
    `for ${nodeInfo.platform}: ${builtAddons.join(", ")}`,
);
