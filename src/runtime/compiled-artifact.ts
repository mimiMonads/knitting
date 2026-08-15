import { getNodeBuiltinModule, getNodeProcess } from "../common/node-compat.ts";
import { toModuleUrl } from "../common/module-url.ts";
import type { CompiledWorkerCheck, CompiledWorkerOptions } from "../types.ts";

export const COMPILED_WORKER_FORMAT = "knitting-compiled-worker";
export const COMPILED_WORKER_FORMAT_VERSION = 1;
export const COMPILED_WORKER_PROTOCOL = "knitting-number-v1";
export const COMPILED_WORKER_JSON_PROTOCOL = "knitting-json-v1";
export const COMPILED_WORKER_EXTENSION = ".knt";

export type CompiledWorkerTask = {
  index: number;
  exportName: string;
};

type CompiledWorkerManifest = {
  format: string;
  version: number;
  protocol: string;
  compiler: string | { name: string; version: string };
  target: { platform: string; arch: string };
  source: string;
  sourceMtimeMs?: number;
  tasks: CompiledWorkerTask[];
};

export type ArtifactInspection = CompiledWorkerCheck & {
  artifactHref: string;
  manifestHref: string;
  taskEntries?: CompiledWorkerTask[];
};

type FsModule = {
  readFileSync: (path: string, encoding: "utf8") => string;
  statSync: (path: string) => {
    isFile: () => boolean;
    mode: number;
    mtimeMs?: number;
  };
};

type UrlModule = {
  fileURLToPath: (url: string) => string;
};

type DenoLike = {
  build?: { os?: string; arch?: string };
  readTextFileSync?: (path: string) => string;
  statSync?: (path: string) => {
    isFile: boolean;
    mode: number | null;
    mtime?: Date | null;
  };
};

const deno = (globalThis as typeof globalThis & { Deno?: DenoLike }).Deno;

const normalizeArch = (arch: string | undefined): string => {
  if (arch === "x86_64") return "x64";
  if (arch === "aarch64") return "arm64";
  return arch ?? "unknown";
};

const runtimeTarget = (): { platform: string; arch: string } => {
  const process = getNodeProcess() as
    | (ReturnType<typeof getNodeProcess> & { arch?: string })
    | undefined;
  if (process !== undefined) {
    return {
      platform: process.platform ?? "unknown",
      arch: normalizeArch(process.arch),
    };
  }
  return {
    platform: deno?.build?.os ?? "unknown",
    arch: normalizeArch(deno?.build?.arch),
  };
};

const normalizeSourceHref = (source: string | URL): string =>
  source instanceof URL ? source.href : toModuleUrl(source);

const resolveHref = (value: string, base: string): string => {
  try {
    return new URL(value).href;
  } catch {
    return new URL(value, base).href;
  }
};

export const defaultCompiledWorkerArtifact = (
  source: string | URL,
): string => {
  const url = new URL(normalizeSourceHref(source));
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\.[^./]+$/, "") +
    COMPILED_WORKER_EXTENSION;
  return url.href;
};

const artifactHrefs = (
  source: string | URL,
  options: CompiledWorkerOptions = {},
): { artifactHref: string; manifestHref: string } => {
  const sourceHref = normalizeSourceHref(source);
  const artifactHref = options.artifact === undefined
    ? defaultCompiledWorkerArtifact(sourceHref)
    : resolveHref(options.artifact, sourceHref);
  const manifestHref = options.manifest === undefined
    ? artifactHref + ".json"
    : resolveHref(options.manifest, artifactHref);
  return { artifactHref, manifestHref };
};

const filePath = (href: string): string => {
  const converter = getNodeBuiltinModule<UrlModule>("node:url")?.fileURLToPath;
  if (converter !== undefined) return converter(href);
  const url = new URL(href);
  if (url.protocol !== "file:") {
    throw new Error(
      "Compiled worker artifact must use file:, got " + url.protocol,
    );
  }
  return decodeURIComponent(url.pathname);
};

const readTextFile = (path: string): string => {
  const fs = getNodeBuiltinModule<FsModule>("node:fs");
  if (fs !== undefined) return fs.readFileSync(path, "utf8");
  if (deno?.readTextFileSync !== undefined) return deno.readTextFileSync(path);
  throw new Error("Synchronous filesystem access is unavailable");
};

const inspectExecutable = (path: string): string | undefined => {
  try {
    const fs = getNodeBuiltinModule<FsModule>("node:fs");
    if (fs !== undefined) {
      const stat = fs.statSync(path);
      if (!stat.isFile()) return "artifact is not a file";
      if (runtimeTarget().platform !== "win32" && (stat.mode & 0o111) === 0) {
        return "artifact is not executable";
      }
      return undefined;
    }
    if (deno?.statSync !== undefined) {
      const stat = deno.statSync(path);
      if (!stat.isFile) return "artifact is not a file";
      if (stat.mode !== null && (stat.mode & 0o111) === 0) {
        return "artifact is not executable";
      }
      return undefined;
    }
    return "filesystem metadata is unavailable";
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    return "artifact is unavailable: " + message;
  }
};

const compilerLabel = (
  compiler: unknown,
): string | undefined => {
  if (typeof compiler === "string" && compiler.length > 0) return compiler;
  if (
    compiler !== null && typeof compiler === "object" &&
    typeof (compiler as { name?: unknown }).name === "string" &&
    (compiler as { name: string }).name.length > 0 &&
    typeof (compiler as { version?: unknown }).version === "string"
  ) {
    const value = compiler as { name: string; version: string };
    return (value.name + " " + value.version).trim();
  }
  return undefined;
};

export const inspectCompiledWorkerArtifact = ({
  source,
  options,
  requiredTasks,
}: {
  source: string | URL;
  options?: CompiledWorkerOptions;
  requiredTasks?: readonly string[];
}): ArtifactInspection => {
  const sourceHref = normalizeSourceHref(source);
  const { artifactHref, manifestHref } = artifactHrefs(sourceHref, options);
  let artifact: string;
  let manifest: string;
  try {
    artifact = filePath(artifactHref);
    manifest = filePath(manifestHref);
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    return {
      compiled: false,
      artifact: artifactHref,
      manifest: manifestHref,
      artifactHref,
      manifestHref,
      reason: message,
    };
  }
  const base: ArtifactInspection = {
    compiled: false,
    artifact,
    manifest,
    artifactHref,
    manifestHref,
  };

  const executableProblem = inspectExecutable(artifact);
  if (executableProblem !== undefined) {
    return { ...base, reason: executableProblem };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readTextFile(manifest));
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    return {
      ...base,
      reason: "manifest is unavailable or invalid: " + message,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...base, reason: "manifest root must be an object" };
  }
  const workerManifest = parsed as CompiledWorkerManifest;

  const compiler = compilerLabel(workerManifest.compiler);
  const details = {
    compiler,
    protocol: typeof workerManifest.protocol === "string"
      ? workerManifest.protocol
      : undefined,
  };
  if (
    workerManifest.format !== COMPILED_WORKER_FORMAT ||
    workerManifest.version !== COMPILED_WORKER_FORMAT_VERSION
  ) {
    return { ...base, ...details, reason: "unsupported manifest format" };
  }
  if (
    workerManifest.protocol !== COMPILED_WORKER_PROTOCOL &&
    workerManifest.protocol !== COMPILED_WORKER_JSON_PROTOCOL
  ) {
    return { ...base, ...details, reason: "unsupported worker protocol" };
  }
  if (compiler === undefined) {
    return { ...base, ...details, reason: "manifest compiler is invalid" };
  }

  const target = runtimeTarget();
  if (
    workerManifest.target?.platform !== target.platform ||
    normalizeArch(workerManifest.target?.arch) !== target.arch
  ) {
    return {
      ...base,
      ...details,
      reason: "artifact target " +
        (workerManifest.target?.platform ?? "unknown") + "/" +
        (workerManifest.target?.arch ?? "unknown") + " does not match " +
        target.platform + "/" + target.arch,
    };
  }

  if (
    !Array.isArray(workerManifest.tasks) || workerManifest.tasks.length === 0
  ) {
    return { ...base, ...details, reason: "manifest has no tasks" };
  }
  const indices = new Set<number>();
  const taskNames = new Set<string>();
  for (const task of workerManifest.tasks) {
    if (
      !Number.isSafeInteger(task?.index) || task.index < 0 ||
      task.index > 0x7fff_ffff ||
      typeof task.exportName !== "string" || task.exportName.length === 0 ||
      indices.has(task.index) || taskNames.has(task.exportName)
    ) {
      return { ...base, ...details, reason: "manifest task table is invalid" };
    }
    indices.add(task.index);
    taskNames.add(task.exportName);
  }

  if (
    typeof workerManifest.source !== "string" ||
    workerManifest.source.length === 0
  ) {
    return { ...base, ...details, reason: "manifest source is invalid" };
  }
  let manifestSource: string;
  try {
    manifestSource = resolveHref(
      workerManifest.source.replace(/\\/g, "/"),
      artifactHref,
    );
  } catch {
    return { ...base, ...details, reason: "manifest source is invalid" };
  }
  if (manifestSource !== sourceHref) {
    return {
      ...base,
      ...details,
      tasks: [...taskNames],
      reason: "manifest was built for a different task module",
    };
  }
  if (Number.isFinite(workerManifest.sourceMtimeMs)) {
    try {
      const sourcePath = filePath(sourceHref);
      const fs = getNodeBuiltinModule<FsModule>("node:fs");
      const currentMtime = fs?.statSync(sourcePath).mtimeMs ??
        deno?.statSync?.(sourcePath).mtime?.getTime();
      if (
        currentMtime !== undefined &&
        currentMtime > workerManifest.sourceMtimeMs! + 0.5
      ) {
        return {
          ...base,
          ...details,
          tasks: [...taskNames],
          reason: "task module changed after the artifact was built",
        };
      }
    } catch {
      return { ...base, ...details, reason: "task module is unavailable" };
    }
  }

  const missing = requiredTasks?.filter((name) => !taskNames.has(name)) ?? [];
  if (missing.length > 0) {
    return {
      ...base,
      ...details,
      tasks: [...taskNames],
      reason: "compiled artifact is missing tasks: " + missing.join(", "),
    };
  }

  return {
    ...base,
    ...details,
    compiled: true,
    tasks: [...taskNames],
    taskEntries: workerManifest.tasks,
  };
};
