import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ResolvedPermissionProtocol } from "../../permission/protocol.ts";
import {
  StrictModeDepthError,
  StrictModeViolationError,
  resolveStrictModeOptions,
  scanCode,
} from "../../permission/strict-scan.ts";
import {
  createMembraneGlobal,
  createSafeReflect,
  type MembraneGlobal,
} from "./strict-membrane.ts";
import {
  createInjectedStrictCallable,
  createNodeVmDynamicImportOptions,
  verifyNoRequire,
} from "./strict-import.ts";

type VmScript = {
  runInContext: (context: object, options?: Record<string, unknown>) => unknown;
};

type VmModuleNamespace = Record<string, unknown>;

type VmModule = {
  identifier?: string;
  namespace: VmModuleNamespace;
  link: (
    linker: (
      specifier: string,
      referencingModule: VmModule,
    ) => VmModule | Promise<VmModule>,
  ) => Promise<void>;
  evaluate: () => Promise<unknown>;
};

type VmSourceTextModule = new (
  code: string,
  options?: Record<string, unknown>,
) => VmModule;

type VmSyntheticModule = new (
  exportNames: string[],
  evaluateCallback: () => void,
  options?: Record<string, unknown>,
) => VmModule;

type VmApi = {
  createContext: (sandbox: object, options?: Record<string, unknown>) => object;
  Script: new (code: string, options?: Record<string, unknown>) => VmScript;
  SourceTextModule?: VmSourceTextModule;
  SyntheticModule?: VmSyntheticModule;
};

type StrictResolvedOptions = ReturnType<typeof resolveStrictModeOptions>;

type StrictSandboxRuntime = {
  membraneGlobal: MembraneGlobal;
  strictOptions: StrictResolvedOptions;
  context?: object;
  vmEnabled: boolean;
  issues: string[];
  vmModuleCache: Map<string, Promise<VmModule>>;
  moduleNamespaceCache: Map<string, VmModuleNamespace>;
  overlayQueue: Promise<void>;
  overlayQueueDepth: number;
};

type MembraneInterceptorBundle = {
  OriginalFunction: Function;
  GeneratorFunction: Function;
  AsyncFunction: Function;
  AsyncGeneratorFunction: Function;
  SecureFunction: Function;
  SecureGeneratorFunction: Function;
  SecureAsyncFunction: Function;
  SecureAsyncGeneratorFunction: Function;
};

type GlobalWithStrictSandboxRuntime = typeof globalThis & {
  __knittingStrictSandboxRuntime?: StrictSandboxRuntime;
};

type GenericCallable = (this: unknown, ...args: unknown[]) => unknown;

type OverlayState = {
  mode: "defined" | "assigned" | "skipped";
  descriptor?: PropertyDescriptor;
  previousValue?: unknown;
};

const ROOT_GLOBAL_RECORD = globalThis as unknown as Record<string, unknown>;
const ROOT_DEFINE_PROPERTY = Object.defineProperty;
const ROOT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const ROOT_DELETE_PROPERTY = Reflect.deleteProperty;
const ROOT_HAS_OWN_PROPERTY = Object.prototype.hasOwnProperty;
const toValueTag = Object.prototype.toString;
const STRICT_SECURE_CONSTRUCTOR = Symbol.for(
  "knitting.strict.secureConstructor",
);

const STRICT_BLOCKED_GLOBALS = [
  "Bun",
  "Deno",
  "process",
  "WebAssembly",
  "fetch",
  "Worker",
  "SharedWorker",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "Proxy",
  "require",
  "module",
] as const;

const STRICT_IMPORT_OVERLAY_GLOBALS = [
  "Bun",
  "Deno",
  "process",
  // Keep eval overlaid during fallback host import so module top-level code
  // cannot capture a reference to host eval before task invocation.
  "eval",
  "require",
  "module",
] as const;
const STRICT_VM_BLOCKED_GLOBALS = STRICT_BLOCKED_GLOBALS.filter(
  (name) => name !== "require" && name !== "module",
);

const BLOCKED_REQUIRE_MODULE_MESSAGE = (
  binding: "require" | "module",
): string =>
  `[Knitting Strict] ${binding} is blocked. Use static imports in your task module.`;

const toFrozenIssue = (error: unknown): string =>
  String((error as { message?: unknown })?.message ?? error).slice(0, 160);

const ignoreError = (action: () => void): void => {
  try {
    action();
  } catch {
  }
};

const tryDefineProperty = (
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor,
): void => {
  ignoreError(() => {
    ROOT_DEFINE_PROPERTY(target, key, descriptor);
  });
};

const tryMirrorCallableMetadata = ({
  target,
  source,
  name,
}: {
  target: Function;
  source: Function;
  name: string;
}): void => {
  tryDefineProperty(target, "name", {
    value: name,
    configurable: true,
  });
  tryDefineProperty(target, "length", {
    value: source.length,
    configurable: true,
  });
  tryDefineProperty(target, "toString", {
    value: () => Function.prototype.toString.call(source),
    configurable: true,
  });
};

const require = createRequire(import.meta.url);

type TsTranspiler = {
  transpileModule: (
    sourceText: string,
    options: {
      fileName: string;
      compilerOptions: {
        module: number;
        target: number;
        sourceMap: boolean;
        inlineSources: boolean;
        inlineSourceMap: boolean;
      };
    },
  ) => {
    outputText: string;
  };
  ModuleKind: {
    ESNext: number;
  };
  ScriptTarget: {
    ES2022: number;
  };
};

const tsTranspiler = (() => {
  try {
    return require("typescript") as TsTranspiler;
  } catch {
    return undefined;
  }
})();

const nodeVm = (() => {
  try {
    return require("node:vm") as VmApi;
  } catch {
    return undefined;
  }
})();

const shouldUseStrictSandbox = (
  protocol?: ResolvedPermissionProtocol,
): boolean =>
  protocol?.enabled === true &&
  protocol.unsafe !== true &&
  protocol.mode === "strict" &&
  protocol.strict.recursiveScan !== false &&
  protocol.strict.sandbox === true;

const toMutableMembraneGlobal = (
  frozenMembrane: MembraneGlobal,
): MembraneGlobal => {
  const mutable = Object.create(null) as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(frozenMembrane)) {
    const descriptor = Object.getOwnPropertyDescriptor(frozenMembrane, key);
    if (!descriptor) continue;
    if ("value" in descriptor) {
      Object.defineProperty(mutable, key, {
        value: descriptor.value,
        writable: true,
        configurable: true,
        enumerable: descriptor.enumerable ?? true,
      });
      continue;
    }
    Object.defineProperty(mutable, key, {
      get: descriptor.get,
      set: descriptor.set,
      configurable: true,
      enumerable: descriptor.enumerable ?? false,
    });
  }
  Object.defineProperty(mutable, "globalThis", {
    value: mutable,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  Object.defineProperty(mutable, "self", {
    value: mutable,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  return mutable as MembraneGlobal;
};

const lockMembraneGlobal = (membraneGlobal: MembraneGlobal): void => {
  const ownKeys = Reflect.ownKeys(membraneGlobal);
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(membraneGlobal, key);
    if (!descriptor) continue;
    if ("value" in descriptor) {
      Object.defineProperty(membraneGlobal, key, {
        value: descriptor.value,
        writable: false,
        configurable: false,
        enumerable: descriptor.enumerable ?? true,
      });
      continue;
    }
    Object.defineProperty(membraneGlobal, key, {
      get: descriptor.get,
      set: undefined,
      configurable: false,
      enumerable: descriptor.enumerable ?? false,
    });
  }
  Object.freeze(membraneGlobal);
};

const defineMembraneValue = (
  membraneGlobal: MembraneGlobal,
  key: string,
  value: unknown,
): void => {
  Object.defineProperty(membraneGlobal, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
};

const collectProtectedReflectTargets = (
  membraneGlobal: MembraneGlobal,
): Set<object> => {
  const protectedTargets = new Set<object>([
    membraneGlobal as unknown as object,
  ]);
  for (const key of Reflect.ownKeys(membraneGlobal)) {
    const value = (membraneGlobal as unknown as Record<PropertyKey, unknown>)[key];
    if (
      (typeof value === "object" && value !== null) ||
      typeof value === "function"
    ) {
      if (Object.isFrozen(value)) protectedTargets.add(value as object);
    }
  }
  return protectedTargets;
};

const installVmBlockedGlobals = (membraneGlobal: MembraneGlobal): void => {
  for (const key of STRICT_VM_BLOCKED_GLOBALS) {
    if (ROOT_HAS_OWN_PROPERTY.call(membraneGlobal, key)) continue;
    defineMembraneValue(membraneGlobal, key, undefined);
  }
};

const wrapMembraneConstructor = ({
  originalCtor,
  origin,
  runScan,
  enter,
  begin,
  end,
}: {
  originalCtor: Function;
  origin: string;
  runScan: (code: string, origin: string, depth: number) => void;
  enter: (origin: string) => number;
  begin: () => void;
  end: () => void;
}): Function => {
  if (
    (originalCtor as unknown as Record<symbol, unknown>)[
      STRICT_SECURE_CONSTRUCTOR
    ] === true
  ) {
    return originalCtor;
  }
  const secure = function (this: unknown, ...args: unknown[]) {
    const nextDepth = enter(origin);
    runScan(args.map((value) => String(value)).join("\n"), origin, nextDepth);
    begin();
    try {
      return Reflect.construct(
        originalCtor,
        args,
        new.target ? (new.target as Function) : originalCtor,
      );
    } finally {
      end();
    }
  };

  tryMirrorCallableMetadata({
    target: secure as Function,
    source: originalCtor,
    name: origin,
  });
  tryDefineProperty(secure as Function, STRICT_SECURE_CONSTRUCTOR, {
    value: true,
    configurable: true,
  });
  ignoreError(() => {
    Object.setPrototypeOf(secure, originalCtor);
  });
  ignoreError(() => {
    (secure as { prototype?: unknown }).prototype =
      (originalCtor as { prototype?: unknown }).prototype;
  });
  return secure;
};

export const installInterceptorsOnMembrane = (
  membraneGlobal: MembraneGlobal,
  strictOptions: StrictResolvedOptions,
): MembraneInterceptorBundle => {
  const maxEvalDepth = strictOptions.maxEvalDepth;
  let evalDepth = 0;

  const runScan = (code: string, origin: string, depth: number): void => {
    const source = `${origin}@depth-${depth}`;
    const result = scanCode(code, { depth, origin, source }, strictOptions);
    if (result.passed === true) return;
    throw new StrictModeViolationError({
      origin,
      depth,
      source,
      violations: result.violations,
      scannedCode: code,
    });
  };

  const enter = (origin: string): number => {
    const nextDepth = evalDepth + 1;
    if (nextDepth >= maxEvalDepth) {
      throw new StrictModeDepthError({
        currentDepth: nextDepth,
        maxDepth: maxEvalDepth,
        origin,
      });
    }
    return nextDepth;
  };

  const begin = (): void => {
    evalDepth++;
  };
  const end = (): void => {
    evalDepth--;
  };

  const OriginalFunction = (membraneGlobal.Function ?? Function) as Function;
  const GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor as Function;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as Function;
  const AsyncGeneratorFunction =
    Object.getPrototypeOf(async function* () {}).constructor as Function;

  const wrapConstructor = (originalCtor: Function, origin: string): Function =>
    wrapMembraneConstructor({
      originalCtor,
      origin,
      runScan,
      enter,
      begin,
      end,
    });
  const SecureFunction = wrapConstructor(OriginalFunction, "Function");
  const SecureGeneratorFunction = wrapConstructor(
    GeneratorFunction,
    "GeneratorFunction",
  );
  const SecureAsyncFunction = wrapConstructor(AsyncFunction, "AsyncFunction");
  const SecureAsyncGeneratorFunction = wrapConstructor(
    AsyncGeneratorFunction,
    "AsyncGeneratorFunction",
  );

  const originalEval = (membraneGlobal.eval ?? globalThis.eval) as (
    source: string,
  ) => unknown;
  const secureEval = (code: unknown): unknown => {
    if (typeof code !== "string") return code;
    const nextDepth = enter("eval");
    runScan(code, "eval", nextDepth);
    begin();
    try {
      return Reflect.apply(originalEval, membraneGlobal, [code]);
    } finally {
      end();
    }
  };

  defineMembraneValue(membraneGlobal, "eval", secureEval);
  defineMembraneValue(membraneGlobal, "Function", SecureFunction);
  const protectedTargets = collectProtectedReflectTargets(membraneGlobal);
  defineMembraneValue(membraneGlobal, "Reflect", createSafeReflect({
    constructors: {
      originalFunction: OriginalFunction,
      secureFunction: SecureFunction,
      originalGeneratorFunction: GeneratorFunction,
      secureGeneratorFunction: SecureGeneratorFunction,
      originalAsyncFunction: AsyncFunction,
      secureAsyncFunction: SecureAsyncFunction,
      originalAsyncGeneratorFunction: AsyncGeneratorFunction,
      secureAsyncGeneratorFunction: SecureAsyncGeneratorFunction,
    },
    protectedTargets,
  }));

  const wrapTimer = (
    originalTimer: (...args: unknown[]) => unknown,
    origin: "setTimeout" | "setInterval",
  ) =>
  (handler: unknown, ...rest: unknown[]) => {
    if (typeof handler === "string") {
      const nextDepth = enter(origin);
      runScan(handler, origin, nextDepth);
    }
    return Reflect.apply(originalTimer, globalThis, [handler, ...rest]);
  };

  for (const [name, origin] of [
    ["setTimeout", "setTimeout"],
    ["setInterval", "setInterval"],
  ] as const) {
    const timer = (globalThis as Record<string, unknown>)[name];
    if (typeof timer !== "function") continue;
    defineMembraneValue(
      membraneGlobal,
      name,
      wrapTimer(timer as (...args: unknown[]) => unknown, origin),
    );
  }
  for (const name of ["clearTimeout", "clearInterval"] as const) {
    const clear = (globalThis as Record<string, unknown>)[name];
    if (typeof clear !== "function") continue;
    defineMembraneValue(membraneGlobal, name, clear.bind(globalThis));
  }

  return {
    OriginalFunction,
    GeneratorFunction,
    AsyncFunction,
    AsyncGeneratorFunction,
    SecureFunction,
    SecureGeneratorFunction,
    SecureAsyncFunction,
    SecureAsyncGeneratorFunction,
  };
};

export const freezePrototypeChains = (
  bundle: MembraneInterceptorBundle,
): void => {
  for (const [prototype, constructorValue] of [
    [bundle.OriginalFunction.prototype, bundle.SecureFunction],
    [bundle.GeneratorFunction.prototype, bundle.SecureGeneratorFunction],
    [bundle.AsyncFunction.prototype, bundle.SecureAsyncFunction],
    [bundle.AsyncGeneratorFunction.prototype, bundle.SecureAsyncGeneratorFunction],
  ] as const) {
    if (!prototype) continue;
    tryDefineProperty(prototype, "constructor", {
      value: constructorValue,
      writable: false,
      configurable: false,
      enumerable: false,
    });
  }
};

const createBlockedRequireOrModuleDescriptor = (
  name: "require" | "module",
): PropertyDescriptor => ({
  get: () => {
    throw new Error(BLOCKED_REQUIRE_MODULE_MESSAGE(name));
  },
  configurable: true,
  enumerable: false,
});

const applyGlobalOverlay = (
  targetName: string,
  overlayDescriptor: PropertyDescriptor,
  state: Map<string, OverlayState>,
): void => {
  const g = ROOT_GLOBAL_RECORD;
  const existing = ROOT_GET_OWN_PROPERTY_DESCRIPTOR(g, targetName);
  if (!existing || existing.configurable === true) {
    let defined = false;
    ignoreError(() => {
      ROOT_DEFINE_PROPERTY(g, targetName, overlayDescriptor);
      defined = true;
    });
    state.set(targetName, defined
      ? {
        mode: "defined",
        descriptor: existing,
      }
      : { mode: "skipped" });
    return;
  }

  if ("value" in existing && existing.writable === true) {
    const previousValue = existing.value;
    const nextValue = "value" in overlayDescriptor
      ? overlayDescriptor.value
      : undefined;
    let assigned = false;
    ignoreError(() => {
      g[targetName] = nextValue;
      assigned = true;
    });
    state.set(targetName, assigned
      ? {
        mode: "assigned",
        previousValue,
      }
      : { mode: "skipped" });
    return;
  }

  state.set(targetName, { mode: "skipped" });
};

const restoreGlobalOverlay = (state: Map<string, OverlayState>): void => {
  const g = ROOT_GLOBAL_RECORD;
  for (const [name, item] of state.entries()) {
    if (item.mode === "defined") {
      if (item.descriptor) {
        tryDefineProperty(g, name, item.descriptor);
        continue;
      }
      ignoreError(() => {
        ROOT_DELETE_PROPERTY(g, name);
      });
      continue;
    }
    if (item.mode === "assigned") {
      ignoreError(() => {
        g[name] = item.previousValue;
      });
    }
  }
};

const isPromiseAcrossRealms = (value: unknown): value is Promise<unknown> =>
  value instanceof Promise ||
  (
    typeof value === "object" &&
    value !== null &&
    toValueTag.call(value) === "[object Promise]"
  );

const applyMembraneOverlay = (
  membraneGlobal: MembraneGlobal,
  explicitNames?: Iterable<string>,
): Map<string, OverlayState> => {
  const globalNames = explicitNames
    ? new Set<string>(explicitNames)
    : new Set<string>([
      ...STRICT_BLOCKED_GLOBALS,
      ...Reflect.ownKeys(membraneGlobal)
        .filter((key): key is string => typeof key === "string"),
    ]);

  const overlayState = new Map<string, OverlayState>();
  for (const name of globalNames) {
    const isMembraneValue = ROOT_HAS_OWN_PROPERTY.call(
      membraneGlobal,
      name,
    );
    const descriptor = isMembraneValue
      ? {
        value: (membraneGlobal as Record<string, unknown>)[name],
        writable: true,
        configurable: true,
        enumerable: true,
      } as PropertyDescriptor
      : (name === "require" || name === "module"
        ? createBlockedRequireOrModuleDescriptor(name)
        : {
          value: undefined,
          writable: true,
          configurable: true,
          enumerable: true,
        } as PropertyDescriptor);
    applyGlobalOverlay(name, descriptor, overlayState);
  }

  return overlayState;
};

const withMembraneOverlayAsync = async <T>(
  membraneGlobal: MembraneGlobal,
  action: () => Promise<T>,
  names?: Iterable<string>,
): Promise<T> => {
  const state = applyMembraneOverlay(membraneGlobal, names);
  try {
    return await action();
  } finally {
    restoreGlobalOverlay(state);
  }
};

const withOverlayQueue = async <T>(
  runtime: StrictSandboxRuntime,
  work: () => Promise<T>,
): Promise<T> => {
  const previous = runtime.overlayQueue;
  runtime.overlayQueueDepth += 1;
  let release: (() => void) | undefined;
  let released = false;
  runtime.overlayQueue = new Promise<void>((resolve) => {
    release = () => {
      if (released) return;
      released = true;
      runtime.overlayQueueDepth = Math.max(0, runtime.overlayQueueDepth - 1);
      resolve();
    };
  });
  await previous;
  try {
    return await work();
  } finally {
    release?.();
  }
};

const withOverlayQueueMaybeSync = <T>(
  runtime: StrictSandboxRuntime,
  work: () => T | Promise<T>,
): T | Promise<T> => {
  if (runtime.overlayQueueDepth > 0) {
    return withOverlayQueue(runtime, async () => await work());
  }

  runtime.overlayQueueDepth += 1;
  let release: (() => void) | undefined;
  let released = false;
  runtime.overlayQueue = new Promise<void>((resolve) => {
    release = () => {
      if (released) return;
      released = true;
      runtime.overlayQueueDepth = Math.max(0, runtime.overlayQueueDepth - 1);
      resolve();
    };
  });

  try {
    const result = work();
    if (!isPromiseAcrossRealms(result)) {
      release?.();
      return result;
    }
    return Promise.resolve(result).then(
      (value) => {
        release?.();
        return value;
      },
      (error) => {
        release?.();
        throw error;
      },
    );
  } catch (error) {
    release?.();
    throw error;
  }
};

const createMembraneInjectedCallable = <T extends (...args: any[]) => any>(
  target: T,
  membraneGlobal: MembraneGlobal,
  runtime?: StrictSandboxRuntime,
): T => {
  const callable = target as unknown as GenericCallable;

  const runWithOverlay = (self: unknown, args: unknown[]) => {
    const overlayState = applyMembraneOverlay(membraneGlobal);
    let result: unknown;

    try {
      result = Reflect.apply(callable, self, args);
    } catch (error) {
      restoreGlobalOverlay(overlayState);
      throw error;
    }

    if (!isPromiseAcrossRealms(result)) {
      restoreGlobalOverlay(overlayState);
      return result;
    }

    return Promise.resolve(result).then(
      (value) => {
        restoreGlobalOverlay(overlayState);
        return value;
      },
      (error) => {
        restoreGlobalOverlay(overlayState);
        throw error;
      },
    );
  };

  const wrapped = function (this: unknown, ...args: unknown[]) {
    if (!runtime) return runWithOverlay(this, args);
    return withOverlayQueueMaybeSync(runtime, () => runWithOverlay(this, args));
  } as unknown as T;

  tryMirrorCallableMetadata({
    target: wrapped as unknown as Function,
    source: target as unknown as Function,
    name: target.name || "strictSandboxInjectedCallable",
  });

  return wrapped;
};

const tryCreateVmContext = (
  membraneGlobal: MembraneGlobal,
): object | undefined => {
  if (!nodeVm) return undefined;
  try {
    return nodeVm.createContext(
      membraneGlobal as unknown as object,
      createNodeVmDynamicImportOptions(),
    );
  } catch {
    return undefined;
  }
};

const lockVmContextGlobalPrototype = (
  context: object,
  issues: string[],
): void => {
  if (!nodeVm) return;
  try {
    const script = new nodeVm.Script("Object.setPrototypeOf(globalThis, null);");
    script.runInContext(context);
  } catch (error) {
    issues.push(
      `[strict-sandbox] failed to lock vm global prototype: ${toFrozenIssue(error)}`,
    );
  }
};

const assertVmContextProxyBlocked = (
  context: object,
  issues: string[],
): void => {
  if (!nodeVm) return;
  try {
    const script = new nodeVm.Script(
      "typeof Proxy === 'undefined' && typeof globalThis.Proxy === 'undefined'",
    );
    const blocked = script.runInContext(context);
    if (blocked !== true) {
      issues.push(
        "[strict-sandbox] vm proxy reachability assertion failed: Proxy is reachable in sandbox context",
      );
    }
  } catch (error) {
    issues.push(
      `[strict-sandbox] vm proxy reachability assertion failed: ${toFrozenIssue(error)}`,
    );
  }
};

const isTypeScriptFilePath = (filePath: string): boolean =>
  filePath.endsWith(".ts") ||
  filePath.endsWith(".mts") ||
  filePath.endsWith(".cts") ||
  filePath.endsWith(".tsx");

const toModuleIdentifier = (
  specifier: string,
  parentIdentifier?: string,
): string => {
  if (specifier.startsWith("node:")) return specifier;
  if (path.isAbsolute(specifier)) return pathToFileURL(specifier).href;
  if (parentIdentifier) {
    try {
      return new URL(specifier, parentIdentifier).href;
    } catch {
    }
  }
  try {
    return new URL(specifier).href;
  } catch {
  }
  return specifier;
};

const toModuleFilePath = (identifier: string): string | undefined => {
  try {
    const parsed = new URL(identifier);
    if (parsed.protocol !== "file:") return undefined;
    return fileURLToPath(parsed);
  } catch {
    return undefined;
  }
};

const transpileModuleSource = ({
  source,
  filePath,
  runtime,
}: {
  source: string;
  filePath: string;
  runtime: StrictSandboxRuntime;
}): string => {
  if (!isTypeScriptFilePath(filePath)) return source;
  if (!tsTranspiler) {
    runtime.issues.push(
      `[strict-sandbox] typescript transpiler unavailable for ${filePath}; using raw source`,
    );
    return source;
  }
  try {
    const out = tsTranspiler.transpileModule(source, {
      fileName: filePath,
      compilerOptions: {
        module: tsTranspiler.ModuleKind.ESNext,
        target: tsTranspiler.ScriptTarget.ES2022,
        sourceMap: false,
        inlineSources: false,
        inlineSourceMap: false,
      },
    });
    return out.outputText;
  } catch (error) {
    runtime.issues.push(
      `[strict-sandbox] transpile failed for ${filePath}: ${toFrozenIssue(error)}`,
    );
    return source;
  }
};

const createHostSyntheticModule = async ({
  identifier,
  runtime,
}: {
  identifier: string;
  runtime: StrictSandboxRuntime;
}): Promise<VmModule> => {
  const SyntheticModule = nodeVm?.SyntheticModule;
  if (!SyntheticModule || !runtime.context) {
    throw new Error("SyntheticModule unavailable");
  }
  const hostModule = await import(identifier);
  const exportNames = Reflect.ownKeys(hostModule)
    .filter((key): key is string => typeof key === "string");
  const uniqueExports = [...new Set(exportNames)];
  const synthetic = new SyntheticModule(
    uniqueExports,
    function (this: { setExport: (name: string, value: unknown) => void }) {
      for (const name of uniqueExports) {
        this.setExport(name, (hostModule as Record<string, unknown>)[name]);
      }
    },
    {
      context: runtime.context as object,
      identifier,
      ...createNodeVmDynamicImportOptions(),
    },
  );
  return synthetic;
};

const createSourceTextModule = async ({
  identifier,
  runtime,
  loadModuleById,
}: {
  identifier: string;
  runtime: StrictSandboxRuntime;
  loadModuleById: (
    moduleIdentifier: string,
    parentIdentifier: string,
  ) => Promise<VmModule>;
}): Promise<VmModule> => {
  const filePath = toModuleFilePath(identifier);
  const SourceTextModule = nodeVm?.SourceTextModule;
  if (!filePath || !SourceTextModule || !runtime.context) {
    throw new Error(`source module unavailable for ${identifier}`);
  }
  const source = readFileSync(filePath, "utf8");
  const preflight = scanCode(source, {
    depth: 0,
    origin: "preflight",
    source: filePath,
  }, runtime.strictOptions);
  if (preflight.passed !== true) {
    throw new StrictModeViolationError({
      origin: "preflight",
      depth: 0,
      source: filePath,
      violations: preflight.violations,
      scannedCode: source,
    });
  }

  const jsSource = transpileModuleSource({
    source,
    filePath,
    runtime,
  });
  const module = new SourceTextModule(jsSource, {
    context: runtime.context as object,
    identifier,
    initializeImportMeta: (meta: unknown) => {
      (meta as Record<string, unknown>).url = identifier;
    },
    ...createNodeVmDynamicImportOptions(),
  });
  await module.link((specifier, referencingModule) => {
    const parent = referencingModule.identifier ?? identifier;
    const nextIdentifier = toModuleIdentifier(specifier, parent);
    return loadModuleById(nextIdentifier, parent);
  });
  return module;
};

const loadVmModuleByIdentifier = (
  identifier: string,
  runtime: StrictSandboxRuntime,
): Promise<VmModule> => {
  const cached = runtime.vmModuleCache.get(identifier);
  if (cached) return cached;

  const pending = (async () => {
    const loadModuleById = (
      moduleIdentifier: string,
      _parentIdentifier: string,
    ) => loadVmModuleByIdentifier(moduleIdentifier, runtime);

    try {
      return await createSourceTextModule({
        identifier,
        runtime,
        loadModuleById,
      });
    } catch (error) {
      runtime.issues.push(
        `[strict-sandbox] source module fallback for ${identifier}: ${toFrozenIssue(error)}`,
      );
      return await createHostSyntheticModule({
        identifier,
        runtime,
      });
    }
  })();

  runtime.vmModuleCache.set(identifier, pending);
  return pending;
};

export const loadModuleInSandbox = async (
  moduleSpecifier: string,
  runtime: StrictSandboxRuntime | undefined,
): Promise<{ namespace: Record<string, unknown>; loadedInSandbox: boolean }> => {
  const fallbackHostImport = async () => {
    if (!runtime) {
      return {
        namespace: (await import(moduleSpecifier)) as Record<string, unknown>,
        loadedInSandbox: false,
      };
    }
    const namespace = await withOverlayQueue(runtime, () =>
      withMembraneOverlayAsync(
        runtime.membraneGlobal,
        async () => (await import(moduleSpecifier)) as Record<string, unknown>,
        STRICT_IMPORT_OVERLAY_GLOBALS,
      )
    );
    return {
      namespace,
      loadedInSandbox: false,
    };
  };

  if (
    !runtime ||
    !runtime.context ||
    !runtime.vmEnabled ||
    !nodeVm?.SourceTextModule ||
    !nodeVm?.SyntheticModule
  ) {
    return await fallbackHostImport();
  }

  const identifier = toModuleIdentifier(moduleSpecifier);
  const cachedNamespace = runtime.moduleNamespaceCache.get(identifier);
  if (cachedNamespace) {
    return {
      namespace: cachedNamespace,
      loadedInSandbox: true,
    };
  }

  try {
    const entryModule = await loadVmModuleByIdentifier(identifier, runtime);
    await entryModule.evaluate();
    const namespace = entryModule.namespace as Record<string, unknown>;
    runtime.moduleNamespaceCache.set(identifier, namespace);
    return {
      namespace,
      loadedInSandbox: true,
    };
  } catch (error) {
    runtime.issues.push(
      `[strict-sandbox] module load failed for ${identifier}: ${toFrozenIssue(error)}`,
    );
    return await fallbackHostImport();
  }
};

const tryCompileVmCallable = <T extends (...args: any[]) => any>(
  runtime: StrictSandboxRuntime,
  target: T,
): GenericCallable | undefined => {
  if (!runtime.context || !nodeVm) return undefined;
  const source = Function.prototype.toString.call(target);
  const filename = `strict-sandbox-task-${target.name || "anonymous"}.mjs`;
  try {
    const script = new nodeVm.Script(`(${source})`, {
      filename,
      ...createNodeVmDynamicImportOptions(),
    });
    const evaluated = script.runInContext(runtime.context, {
      displayErrors: true,
    });
    if (typeof evaluated === "function") {
      return evaluated as GenericCallable;
    }
    runtime.issues.push(
      `[strict-sandbox] vm compile result for ${target.name || "anonymous"} was not callable`,
    );
    return undefined;
  } catch (error) {
    runtime.issues.push(
      `[strict-sandbox] vm compile failed for ${target.name || "anonymous"}: ${toFrozenIssue(error)}`,
    );
    return undefined;
  }
};

const isUnresolvedSandboxReference = (error: unknown): boolean => {
  const message = String((error as { message?: unknown })?.message ?? error);
  return message.includes("is not defined") ||
    message.includes("Cannot access") ||
    message.includes("before initialization");
};

export const loadInSandbox = <T extends (...args: any[]) => any>(
  target: T,
  runtime: StrictSandboxRuntime | undefined,
): T => {
  if (!runtime) return createInjectedStrictCallable(target);

  const injectedFallback = createMembraneInjectedCallable(
    target,
    runtime.membraneGlobal,
    runtime,
  );
  const vmCallable = tryCompileVmCallable(runtime, target);
  if (!vmCallable) return injectedFallback as unknown as T;

  const wrapped = function (this: unknown, ...args: unknown[]) {
    try {
      return Reflect.apply(vmCallable, this, args);
    } catch (error) {
      if (!isUnresolvedSandboxReference(error)) throw error;
      runtime.issues.push(
        `[strict-sandbox] unresolved reference fallback for ${target.name || "anonymous"}: ${toFrozenIssue(error)}`,
      );
      return Reflect.apply(
        injectedFallback as unknown as GenericCallable,
        this,
        args,
      );
    }
  } as unknown as T;

  tryMirrorCallableMetadata({
    target: wrapped as unknown as Function,
    source: target as unknown as Function,
    name: target.name || "strictSandboxCallable",
  });

  return wrapped;
};

const bindContextSelfReferences = (
  membraneGlobal: MembraneGlobal,
  context: object,
): void => {
  const contextGlobal = context as unknown as MembraneGlobal;
  defineMembraneValue(membraneGlobal, "globalThis", contextGlobal);
  defineMembraneValue(membraneGlobal, "self", contextGlobal);
};

const createStrictSandboxRuntime = (
  protocol: ResolvedPermissionProtocol,
): StrictSandboxRuntime => {
  const strictOptions = resolveStrictModeOptions(protocol.strict);
  const issues: string[] = [];

  const frozenMembrane = createMembraneGlobal({
    allowConsole: protocol.allowConsole === true,
    allowCrypto: true,
    allowPerformance: true,
  });
  const membraneGlobal = toMutableMembraneGlobal(frozenMembrane);
  installVmBlockedGlobals(membraneGlobal);
  verifyNoRequire(membraneGlobal as unknown as object);
  const interceptors = installInterceptorsOnMembrane(
    membraneGlobal,
    strictOptions,
  );
  freezePrototypeChains(interceptors);
  const context = tryCreateVmContext(membraneGlobal);
  if (context) {
    lockVmContextGlobalPrototype(context, issues);
    assertVmContextProxyBlocked(context, issues);
  }
  if (context) {
    bindContextSelfReferences(membraneGlobal, context);
  }
  lockMembraneGlobal(membraneGlobal);
  if (!context) {
    issues.push(
      "[strict-sandbox] node:vm unavailable; using membrane injected fallback (reduced isolation vs vm context)",
    );
  } else if (!nodeVm?.SourceTextModule || !nodeVm?.SyntheticModule) {
    issues.push(
      "[strict-sandbox] vm modules unavailable (missing --experimental-vm-modules); module-level sandbox loader disabled",
    );
  }

  return {
    membraneGlobal,
    strictOptions,
    context,
    vmEnabled: Boolean(
      context && nodeVm?.SourceTextModule && nodeVm?.SyntheticModule,
    ),
    issues,
    vmModuleCache: new Map<string, Promise<VmModule>>(),
    moduleNamespaceCache: new Map<string, VmModuleNamespace>(),
    overlayQueue: Promise.resolve(),
    overlayQueueDepth: 0,
  };
};

export const ensureStrictSandboxRuntime = (
  protocol?: ResolvedPermissionProtocol,
): StrictSandboxRuntime | undefined => {
  if (!protocol || !shouldUseStrictSandbox(protocol)) return undefined;
  const g = globalThis as GlobalWithStrictSandboxRuntime;
  if (g.__knittingStrictSandboxRuntime) return g.__knittingStrictSandboxRuntime;
  const runtime = createStrictSandboxRuntime(protocol);
  g.__knittingStrictSandboxRuntime = runtime;
  return runtime;
};

export type { StrictSandboxRuntime as StrictSandboxRuntime };
