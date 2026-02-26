import { createRequire } from "node:module";

type ViolationSeverity = "block" | "warn";

type PatternCategory =
  | "ffi"
  | "fs"
  | "thread"
  | "eval"
  | "import"
  | "global";

type PatternDefinition = {
  id: string;
  regex: RegExp;
  category: PatternCategory;
  severity: ViolationSeverity;
  description?: string;
  runtimeOnly?: boolean;
  preflightOnly?: boolean;
};

type Violation = {
  pattern: string;
  match: string;
  line: number;
  column: number;
  category: string;
  severity: ViolationSeverity;
};

type ScanContext = {
  depth: number;
  origin: string;
  parentOrigin?: string;
  source?: string;
};

type ScanResult = {
  passed: boolean;
  violations: Violation[];
};

type StrictModeOptions = {
  recursiveScan?: boolean;
  maxEvalDepth?: number;
  additionalPatterns?: PatternDefinition[];
  excludePatterns?: string[];
  onWarning?: (violation: Violation) => void;
  onScan?: (context: ScanContext, result: ScanResult) => void;
};

const MIN_MAX_EVAL_DEPTH = 1;
const MAX_MAX_EVAL_DEPTH = 64;
const DEFAULT_MAX_EVAL_DEPTH = 16;
const NON_EXCLUDABLE_PATTERN_IDS = new Set([
  "FFI-01",
  "FFI-02",
  "FFI-03",
  "FFI-04",
  "FFI-05",
  "FFI-06",
]);

const createBlockPattern = (
  id: string,
  regex: RegExp,
  category: PatternCategory,
  flags?: Pick<PatternDefinition, "preflightOnly" | "runtimeOnly" | "description">,
): PatternDefinition => ({
  id,
  regex,
  category,
  severity: "block",
  ...flags,
});

const PATTERN_REGISTRY: PatternDefinition[] = [
  // FFI & native execution
  createBlockPattern("FFI-01", /\bbun\s*:\s*ffi\b/g, "ffi"),
  createBlockPattern("FFI-02", /\bBun\s*\.\s*dlopen\b/g, "ffi"),
  createBlockPattern("FFI-03", /\bBun\s*\.\s*linkSymbols\b/g, "ffi"),
  createBlockPattern("FFI-04", /\bprocess\s*\.\s*dlopen\b/g, "ffi"),
  createBlockPattern("FFI-05", /\bprocess\s*\.\s*binding\b/g, "ffi"),
  createBlockPattern("FFI-06", /\bprocess\s*\.\s*_linkedBinding\b/g, "ffi"),
  // Filesystem
  createBlockPattern("FS-01", /\bnode\s*:\s*fs\b/g, "fs"),
  createBlockPattern("FS-02", /['"]fs['"]/g, "fs"),
  createBlockPattern("FS-03", /['"]fs\/promises['"]/g, "fs"),
  // Threading / worker escape
  createBlockPattern("THR-01", /\bnode\s*:\s*worker_threads\b/g, "thread"),
  createBlockPattern("THR-02", /\bnode\s*:\s*child_process\b/g, "thread"),
  createBlockPattern("THR-03", /\bnode\s*:\s*cluster\b/g, "thread"),
  // Dynamic code generation
  createBlockPattern("EVAL-01", /\beval\s*\(/g, "eval", { preflightOnly: true }),
  createBlockPattern("EVAL-02", /\bnew\s+Function\s*\(/g, "eval", {
    preflightOnly: true,
  }),
  createBlockPattern("EVAL-03", /\bFunction\s*\(/g, "eval", {
    preflightOnly: true,
  }),
  createBlockPattern("EVAL-04", /\bsetTimeout\s*\(\s*['"`]/g, "eval"),
  createBlockPattern("EVAL-05", /\bsetInterval\s*\(\s*['"`]/g, "eval"),
  // Module import escape
  createBlockPattern("IMP-01", /\bimport\s*\(/g, "import"),
  createBlockPattern("IMP-02", /\brequire\s*\(/g, "import"),
  createBlockPattern("IMP-03", /\brequire\s*\.\s*resolve\s*\(/g, "import"),
  createBlockPattern("IMP-04", /\bimport\s*\.\s*meta\b/g, "import"),
  createBlockPattern("IMP-06", /\bmodule\s*\.\s*createRequire\b/g, "import"),
  // Global scope escape
  createBlockPattern(
    "GLOB-01",
    /\bFunction\s*\(\s*['"]return\s+this['"]\s*\)/g,
    "global",
  ),
  createBlockPattern("GLOB-02", /\bconstructor\s*\.\s*constructor\s*\(/g, "global"),
];

const clampMaxDepth = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_MAX_EVAL_DEPTH;
  const int = Math.floor(value as number);
  if (int < MIN_MAX_EVAL_DEPTH) return MIN_MAX_EVAL_DEPTH;
  if (int > MAX_MAX_EVAL_DEPTH) return MAX_MAX_EVAL_DEPTH;
  return int;
};

const toFrozenScanResult = (result: ScanResult): ScanResult => ({
  passed: result.passed,
  violations: Object.freeze(
    result.violations.map((v) => Object.freeze({ ...v })),
  ) as unknown as Violation[],
});

const AST_CACHE_LIMIT = 256;
const astViolationCache = new Map<string, readonly Violation[]>();

const FUNCTION_CONSTRUCTOR_ORIGINS = new Set([
  "Function",
  "GeneratorFunction",
  "AsyncFunction",
  "AsyncGeneratorFunction",
]);
const isFunctionConstructorOrigin = (origin: string): boolean =>
  FUNCTION_CONSTRUCTOR_ORIGINS.has(origin);

const toAstCacheKey = ({
  source,
  context,
}: {
  source: string;
  context: ScanContext;
}): string => `${isFunctionConstructorOrigin(context.origin) ? "fn" : "src"}:${source}`;

const getCachedAstViolations = (key: string): Violation[] | undefined => {
  const cached = astViolationCache.get(key);
  if (!cached) return undefined;
  // LRU touch.
  astViolationCache.delete(key);
  astViolationCache.set(key, cached);
  return cached.map((entry) => ({ ...entry }));
};

const storeAstViolations = (key: string, violations: Violation[]): Violation[] => {
  setCachedAstViolations(key, violations);
  return violations;
};

const setCachedAstViolations = (key: string, violations: Violation[]): void => {
  astViolationCache.delete(key);
  astViolationCache.set(
    key,
    Object.freeze(violations.map((entry) => Object.freeze({ ...entry }))),
  );
  if (astViolationCache.size <= AST_CACHE_LIMIT) return;
  const oldest = astViolationCache.keys().next().value;
  if (typeof oldest === "string") astViolationCache.delete(oldest);
};

type TsSourceLocation = {
  line: number;
  character: number;
};

type TsLike = {
  SyntaxKind: Record<string, number>;
  ScriptTarget: { Latest: number };
  ScriptKind: { TS: number };
  createSourceFile: (
    fileName: string,
    sourceText: string,
    languageVersion: number,
    setParentNodes?: boolean,
    scriptKind?: number,
  ) => {
    parseDiagnostics?: Array<{
      start?: number;
      messageText?: string | { messageText?: string };
    }>;
    getLineAndCharacterOfPosition: (position: number) => TsSourceLocation;
  };
  forEachChild: (node: unknown, cbNode: (node: unknown) => void) => void;
};

const require = createRequire(import.meta.url);
const tsApi = (() => {
  try {
    return require("typescript") as TsLike;
  } catch {
    return undefined;
  }
})();

const toAstViolation = ({
  pattern,
  match,
  line,
  column,
}: {
  pattern: string;
  match: string;
  line: number;
  column: number;
}): Violation => ({
  pattern,
  match,
  line: Math.max(1, line),
  column: Math.max(1, column),
  category: "import",
  severity: "block",
});

const toLineColumnFromIndex = (
  source: string,
  index: number,
): { line: number; column: number } => {
  const bounded = Math.max(0, Math.min(index, source.length));
  let line = 1;
  let column = 1;
  for (let i = 0; i < bounded; i++) {
    const ch = source.charCodeAt(i);
    if (ch === 10 /* \n */) {
      line++;
      column = 1;
      continue;
    }
    column++;
  }
  return { line, column };
};

const forEachRegexMatch = (
  source: string,
  regex: RegExp,
  cb: (found: RegExpMatchArray) => void,
): void => {
  regex.lastIndex = 0;
  for (const found of source.matchAll(regex)) cb(found);
};

const scanAstHeuristic = ({
  source,
  context,
}: {
  source: string;
  context: ScanContext;
}): Violation[] => {
  const out: Violation[] = [];
  for (const [regex, pattern, match] of [
    [/\bimport\s*\(/g, "AST-ImportExpression", "import(...)"],
    [/\bimport\s*\.\s*meta\b/g, "AST-MetaProperty", "import.meta"],
    [/\brequire\s*\(/g, "AST-CallExpression:require", "require(...)"],
  ] as const) {
    forEachRegexMatch(source, regex, (found) => {
      const { line, column } = toLineColumnFromIndex(source, found.index ?? 0);
      out.push(toAstViolation({ pattern, match, line, column }));
    });
  }

  if (out.length === 0 && context.depth > 0) {
    try {
      // Runtime intercepted strings are function bodies or scripts.
      // Function constructor parse is a cheap fallback when TS parser is unavailable.
      new Function(source);
    } catch (error) {
      out.push(toAstViolation({
        pattern: "AST-PARSE",
        match: String((error as { message?: unknown })?.message ?? error).slice(
          0,
          120,
        ),
        line: 1,
        column: 1,
      }));
    }
  }

  return out;
};

const parseSourceWithTs = ({
  source,
  context,
}: {
  source: string;
  context: ScanContext;
}): {
  sourceFile?: {
    parseDiagnostics?: Array<{
      start?: number;
      messageText?: string | { messageText?: string };
    }>;
    getLineAndCharacterOfPosition: (position: number) => TsSourceLocation;
  };
  lineOffset: number;
  parseError?: Violation;
} => {
  const ts = tsApi;
  if (!ts) {
    return {
      lineOffset: 0,
    };
  }
  const fileName = context.source ?? "strict-scan-input.ts";
  const wrapAsFunctionBody = isFunctionConstructorOrigin(context.origin);
  const wrappedSource = wrapAsFunctionBody
    ? `function __knitting_scan_wrapper__(){\n${source}\n}`
    : source;
  const lineOffset = wrapAsFunctionBody ? -1 : 0;
  const sourceFile = ts.createSourceFile(
    fileName,
    wrappedSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const diagnostics = sourceFile.parseDiagnostics ?? [];
  if (diagnostics.length === 0) {
    return {
      sourceFile,
      lineOffset,
    };
  }
  const first = diagnostics[0];
  const start = typeof first?.start === "number" ? first.start : 0;
  const position = sourceFile.getLineAndCharacterOfPosition(start);
  const rawMessage = first?.messageText;
  const message = typeof rawMessage === "string"
    ? rawMessage
    : rawMessage?.messageText ?? "syntax parse failure";
  return {
    sourceFile,
    lineOffset,
    parseError: toAstViolation({
      pattern: "AST-PARSE",
      match: String(message).slice(0, 120),
      line: position.line + 1 + lineOffset,
      column: position.character + 1,
    }),
  };
};

const scanAst = ({
  source,
  context,
}: {
  source: string;
  context: ScanContext;
}): Violation[] => {
  const cacheKey = toAstCacheKey({ source, context });
  const cached = getCachedAstViolations(cacheKey);
  if (cached) return cached;

  if (!tsApi) return storeAstViolations(cacheKey, scanAstHeuristic({ source, context }));

  const parsed = parseSourceWithTs({ source, context });
  const sourceFile = parsed.sourceFile;
  if (!sourceFile) return storeAstViolations(cacheKey, scanAstHeuristic({ source, context }));
  if (parsed.parseError) return storeAstViolations(cacheKey, [parsed.parseError]);

  const out: Violation[] = [];
  const syntaxKind = tsApi.SyntaxKind;
  const toLineColumn = (node: unknown): { line: number; column: number } => {
    const nodeAny = node as { getStart?: (sf?: unknown) => number; pos?: number };
    const start = typeof nodeAny.getStart === "function"
      ? nodeAny.getStart(sourceFile)
      : (typeof nodeAny.pos === "number" ? nodeAny.pos : 0);
    const pos = sourceFile.getLineAndCharacterOfPosition(start);
    return {
      line: pos.line + 1 + parsed.lineOffset,
      column: pos.character + 1,
    };
  };
  const pushNodeViolation = (node: unknown, pattern: string, match: string) => {
    const { line, column } = toLineColumn(node);
    out.push(toAstViolation({ pattern, match, line, column }));
  };
  const visit = (node: unknown): void => {
    const n = node as {
      kind?: number;
      expression?: { kind?: number; escapedText?: string };
      keywordToken?: number;
      name?: { escapedText?: string };
    };
    if (
      n.kind === syntaxKind.CallExpression &&
      n.expression?.kind === syntaxKind.ImportKeyword
    ) {
      pushNodeViolation(node, "AST-ImportExpression", "import(...)");
    }
    if (
      n.kind === syntaxKind.MetaProperty &&
      n.keywordToken === syntaxKind.ImportKeyword &&
      n.name?.escapedText === "meta"
    ) {
      pushNodeViolation(node, "AST-MetaProperty", "import.meta");
    }
    if (
      n.kind === syntaxKind.CallExpression &&
      n.expression?.kind === syntaxKind.Identifier &&
      n.expression.escapedText === "require"
    ) {
      pushNodeViolation(node, "AST-CallExpression:require", "require(...)");
    }
    tsApi.forEachChild(node, visit);
  };
  visit(sourceFile);
  return storeAstViolations(cacheKey, out);
};

const validatePatternRegistry = (
  patterns: PatternDefinition[],
): PatternDefinition[] => {
  const seen = new Set<string>();
  const out: PatternDefinition[] = [];
  for (const pattern of patterns) {
    if (seen.has(pattern.id)) {
      throw new Error(`duplicate strict pattern id: ${pattern.id}`);
    }
    seen.add(pattern.id);
    if (pattern.regex.global !== true) {
      throw new Error(`strict pattern ${pattern.id} must include /g flag`);
    }
    out.push(pattern);
  }
  return out;
};

const resolvePatternRegistry = (
  options?: StrictModeOptions,
): PatternDefinition[] => {
  const exclude = new Set(options?.excludePatterns ?? []);
  for (const id of exclude) {
    if (NON_EXCLUDABLE_PATTERN_IDS.has(id)) {
      throw new Error(`strict pattern ${id} cannot be excluded`);
    }
  }
  return validatePatternRegistry([
    ...PATTERN_REGISTRY,
    ...(options?.additionalPatterns ?? []),
  ])
    .filter((pattern) => !exclude.has(pattern.id));
};

export class StrictModeViolationError extends Error {
  override name = "StrictModeViolationError";
  violations: Violation[];
  origin: string;
  depth: number;
  source?: string;
  scannedCode?: string;

  constructor({
    origin,
    depth,
    source,
    violations,
    scannedCode,
  }: {
    origin: string;
    depth: number;
    source?: string;
    violations: Violation[];
    scannedCode?: string;
  }) {
    const first = violations[0];
    const details = first
      ? `${first.pattern} at ${first.line}:${first.column} (${first.match})`
      : "unknown violation";
    super(
      `KNT_ERROR_PERMISSION_DENIED: strict mode blocked ${origin} at depth ${depth}: ${details}`,
    );
    this.violations = violations;
    this.origin = origin;
    this.depth = depth;
    this.source = source;
    this.scannedCode = typeof scannedCode === "string"
      ? scannedCode.slice(0, 200)
      : undefined;
  }
}

export class StrictModeDepthError extends Error {
  override name = "StrictModeDepthError";
  currentDepth: number;
  maxDepth: number;
  origin: string;

  constructor({
    currentDepth,
    maxDepth,
    origin,
  }: {
    currentDepth: number;
    maxDepth: number;
    origin: string;
  }) {
    super(
      `KNT_ERROR_PERMISSION_DENIED: strict mode depth limit reached in ${origin} (${currentDepth}/${maxDepth})`,
    );
    this.currentDepth = currentDepth;
    this.maxDepth = maxDepth;
    this.origin = origin;
  }
}

export const scanCode = (
  code: string,
  context: ScanContext,
  options?: StrictModeOptions,
): ScanResult => {
  if (code == null) {
    throw new TypeError("scanCode: input must not be null or undefined");
  }

  const source = String(code);
  if (source.length === 0) {
    const out = { passed: true, violations: [] } as ScanResult;
    options?.onScan?.(context, toFrozenScanResult(out));
    return out;
  }

  const registry = resolvePatternRegistry(options);
  const isPreflight = context.depth === 0;
  const patterns = registry.filter((pattern) =>
    isPreflight ? pattern.runtimeOnly !== true : pattern.preflightOnly !== true
  );
  const violations: Violation[] = [];
  for (const pattern of patterns) {
    forEachRegexMatch(source, pattern.regex, (match) => {
      const violation: Violation = {
        pattern: pattern.id,
        match: match[0]!,
        ...toLineColumnFromIndex(source, match.index ?? 0),
        category: pattern.category,
        severity: pattern.severity,
      };
      violations.push(violation);
      if (violation.severity === "warn") options?.onWarning?.(violation);
    });
  }

  violations.push(...scanAst({ source, context }));

  const out = {
    passed: violations.every((violation) => violation.severity !== "block"),
    violations,
  } as ScanResult;
  options?.onScan?.(context, toFrozenScanResult(out));
  return out;
};

export const resolveStrictModeOptions = (
  input: StrictModeOptions | undefined,
): Required<Pick<StrictModeOptions, "recursiveScan" | "maxEvalDepth">> &
  Omit<StrictModeOptions, "recursiveScan" | "maxEvalDepth"> => ({
    recursiveScan: input?.recursiveScan !== false,
    maxEvalDepth: clampMaxDepth(input?.maxEvalDepth),
    additionalPatterns: input?.additionalPatterns ?? [],
    excludePatterns: input?.excludePatterns ?? [],
    onWarning: input?.onWarning,
    onScan: input?.onScan,
  });

export type {
  PatternDefinition,
  ScanContext,
  ScanResult,
  StrictModeOptions,
  Violation,
};
