import { getNodeBuiltinModule, getNodeProcess } from "../common/node-compat.ts";
import type { CompiledWorkerOptions } from "../types.ts";
import type { ArtifactInspection } from "./compiled-artifact.ts";

type ChildProcessModule = {
  spawnSync: (
    command: string,
    args: string[],
    options: Record<string, unknown>,
  ) => { error?: Error; status: number | null };
};

type UrlModule = { fileURLToPath: (url: string) => string };

const filePath = (href: string): string => {
  const converter = getNodeBuiltinModule<UrlModule>("node:url")?.fileURLToPath;
  if (converter !== undefined) return converter(href);
  return decodeURIComponent(new URL(href).pathname);
};

const runtimeExecutable = (): string => {
  const process = getNodeProcess() as
    | (ReturnType<typeof getNodeProcess> & {
      execPath?: string;
      versions?: { bun?: string; node?: string; modules?: string };
    })
    | undefined;
  return process?.versions?.bun !== undefined && process.execPath !== undefined
    ? process.execPath
    : "bun";
};

export const buildCompiledWorkerArtifact = ({
  inspection,
  source,
  tasks,
  options,
}: {
  inspection: ArtifactInspection;
  source: string;
  tasks: readonly string[];
  options?: CompiledWorkerOptions;
}): void => {
  const childProcess = getNodeBuiltinModule<ChildProcessModule>(
    "node:child_process",
  );
  if (childProcess === undefined) {
    throw new Error("automatic compilation requires Bun or Node child processes");
  }
  const builder = filePath(
    new URL("../../scripts/build-compiled-worker.ts", import.meta.url).href,
  );
  const args = [
    builder,
    "--module",
    filePath(source),
    "--out",
    filePath(inspection.artifactHref),
    "--manifest",
    filePath(inspection.manifestHref),
    "--tasks",
    tasks.join(","),
  ];
  if (options?.compiler !== undefined) {
    args.push("--porf", options.compiler);
  }
  const result = childProcess.spawnSync(runtimeExecutable(), args, {
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error("compiled worker build exited with code " + result.status);
  }
};
