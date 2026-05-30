import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool, importTask, isMain } from "./knitting.ts";

const docker = process.env.DOCKER_BINARY ?? "docker";
const image = process.env.KNITTING_DOCKER_IMAGE ?? "node:24-trixie-slim";
const cwd = process.cwd();

export const addOne = importTask<number, number>({
  href: "./docker-worker-tasks.ts",
  name: "addOne",
});

export const reportIsMain = importTask<void, boolean>({
  href: "./docker-worker-tasks.ts",
  name: "reportIsMain",
});

export const runtimeName = importTask<void, string>({
  href: "./docker-worker-tasks.ts",
  name: "runtimeName",
});

const dockerPrefix = (cidfile: string): string[] => [
  docker,
  "run",
  "--ipc=host",
  "--cidfile",
  cidfile,
  "-v",
  `${cwd}:${cwd}`,
  "-w",
  cwd,
  "-e",
  "KNITTING_PROCESS_WORKER",
  "-e",
  "KNITTING_PROCESS_WORKER_BOOT",
  image,
];

const removeContainer = async (cidfile: string): Promise<void> => {
  let containerId = "";
  try {
    containerId = (await readFile(cidfile, "utf8")).trim();
  } catch {
    return;
  }
  if (containerId.length === 0) return;

  await new Promise<void>((resolve) => {
    const child = spawn(docker, ["rm", "-f", containerId], {
      stdio: "ignore",
    });
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
};

const main = async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "knitting-docker-"));
  const cidfile = join(tempDir, "worker.cid");

  const pool = createPool({
    threads: 1,
    source: import.meta.url,
    worker: {
      runtime: "process",
      processRuntime: "node",
      processSharedMemory: "named",
      processCommandPrefix: dockerPrefix(cidfile),
    },
    permission: "unsafe",
  })({ addOne, reportIsMain, runtimeName });

  try {
    const [value, workerIsMain, runtime] = await Promise.all([
      pool.call.addOne(41),
      pool.call.reportIsMain(),
      pool.call.runtimeName(),
    ]);

    console.log({
      image,
      runtime,
      value,
      workerIsMain,
      ok: value === 42 && workerIsMain === false,
    });
  } finally {
    await removeContainer(cidfile);
    await pool.shutdown().catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true });
  }
};

if (isMain) {
  await main();
}
