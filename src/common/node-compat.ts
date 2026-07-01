export type NodeProcessLike = {
  getBuiltinModule?: (id: string) => unknown;
  versions?: {
    modules?: string;
    node?: string;
  };
  platform?: string;
  allowedNodeEnvironmentFlags?: ReadonlySet<string>;
  execArgv?: string[];
  execPath?: string;
  cwd?: () => string;
  env?: Record<string, string | undefined>;
  on?: (event: string, handler: (...args: unknown[]) => void) => unknown;
};

export type NodeCallSiteLike = {
  getFileName?: () => string | null | undefined;
  getFunctionName?: () => string | null | undefined;
  getMethodName?: () => string | null | undefined;
};

const nodeProcess = (() => {
  const candidate = (globalThis as typeof globalThis & { process?: unknown })
    .process as NodeProcessLike | undefined;
  return typeof candidate?.versions?.node === "string" ? candidate : undefined;
})();

export const getNodeProcess = (): NodeProcessLike | undefined => nodeProcess;

export const getNodeBuiltinModule = <T>(specifier: string): T | undefined => {
  const getter = nodeProcess?.getBuiltinModule;
  if (typeof getter !== "function") return undefined;

  try {
    return getter.call(nodeProcess, specifier) as T | undefined;
  } catch {
  }

  if (!specifier.startsWith("node:")) return undefined;

  try {
    return getter.call(nodeProcess, specifier.slice(5)) as T | undefined;
  } catch {
    return undefined;
  }
};
