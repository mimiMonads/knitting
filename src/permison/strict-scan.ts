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

const PATTERN_REGISTRY: PatternDefinition[] = [
  // FFI & native execution
  {
    id: "FFI-01",
    regex: /\bbun\s*:\s*ffi\b/g,
    category: "ffi",
    severity: "block",
  },
  {
    id: "FFI-02",
    regex: /\bBun\s*\.\s*dlopen\b/g,
    category: "ffi",
    severity: "block",
  },
  {
    id: "FFI-03",
    regex: /\bBun\s*\.\s*linkSymbols\b/g,
    category: "ffi",
    severity: "block",
  },
  {
    id: "FFI-04",
    regex: /\bprocess\s*\.\s*dlopen\b/g,
    category: "ffi",
    severity: "block",
  },
  {
    id: "FFI-05",
    regex: /\bprocess\s*\.\s*binding\b/g,
    category: "ffi",
    severity: "block",
  },
  {
    id: "FFI-06",
    regex: /\bprocess\s*\.\s*_linkedBinding\b/g,
    category: "ffi",
    severity: "block",
  },
  // Filesystem
  {
    id: "FS-01",
    regex: /\bnode\s*:\s*fs\b/g,
    category: "fs",
    severity: "block",
  },
  {
    id: "FS-02",
    regex: /['"]fs['"]/g,
    category: "fs",
    severity: "block",
  },
  {
    id: "FS-03",
    regex: /['"]fs\/promises['"]/g,
    category: "fs",
    severity: "block",
  },
  // Threading / worker escape
  {
    id: "THR-01",
    regex: /\bnode\s*:\s*worker_threads\b/g,
    category: "thread",
    severity: "block",
  },
  {
    id: "THR-02",
    regex: /\bnode\s*:\s*child_process\b/g,
    category: "thread",
    severity: "block",
  },
  {
    id: "THR-03",
    regex: /\bnode\s*:\s*cluster\b/g,
    category: "thread",
    severity: "block",
  },
  // Dynamic code generation
  {
    id: "EVAL-01",
    regex: /\beval\s*\(/g,
    category: "eval",
    severity: "block",
    preflightOnly: true,
  },
  {
    id: "EVAL-02",
    regex: /\bnew\s+Function\s*\(/g,
    category: "eval",
    severity: "block",
    preflightOnly: true,
  },
  {
    id: "EVAL-03",
    regex: /\bFunction\s*\(/g,
    category: "eval",
    severity: "block",
    preflightOnly: true,
  },
  {
    id: "EVAL-04",
    regex: /\bsetTimeout\s*\(\s*['"`]/g,
    category: "eval",
    severity: "block",
  },
  {
    id: "EVAL-05",
    regex: /\bsetInterval\s*\(\s*['"`]/g,
    category: "eval",
    severity: "block",
  },
  // Module import escape
  {
    id: "IMP-01",
    regex: /\bimport\s*\(/g,
    category: "import",
    severity: "block",
  },
  {
    id: "IMP-02",
    regex: /\brequire\s*\(/g,
    category: "import",
    severity: "block",
  },
  {
    id: "IMP-03",
    regex: /\brequire\s*\.\s*resolve\s*\(/g,
    category: "import",
    severity: "block",
  },
  {
    id: "IMP-04",
    regex: /\bimport\s*\.\s*meta\b/g,
    category: "import",
    severity: "block",
  },
  {
    id: "IMP-06",
    regex: /\bmodule\s*\.\s*createRequire\b/g,
    category: "import",
    severity: "block",
  },
  // Global scope escape
  {
    id: "GLOB-01",
    regex: /\bFunction\s*\(\s*['"]return\s+this['"]\s*\)/g,
    category: "global",
    severity: "block",
  },
  {
    id: "GLOB-02",
    regex: /\bconstructor\s*\.\s*constructor\s*\(/g,
    category: "global",
    severity: "block",
  },
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

const isFunctionConstructorOrigin = (origin: string): boolean =>
  origin === "Function" ||
  origin === "GeneratorFunction" ||
  origin === "AsyncFunction" ||
  origin === "AsyncGeneratorFunction";

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
const tsRuntime = (() => {
  try {
    return {
      api: require("typescript") as TsLike,
      unavailableReason: undefined,
    };
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error)
      .slice(0, 120);
    return {
      api: undefined,
      unavailableReason: message,
    };
  }
})();

const tsApi = tsRuntime.api;

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

const toAstUnavailableViolation = (): Violation =>
  toAstViolation({
    pattern: "AST-PARSE",
    match: `parser unavailable: ${tsRuntime.unavailableReason ?? "unknown parser error"}`,
    line: 1,
    column: 1,
  });

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
  wrappedSource: string;
  lineOffset: number;
  parseError?: Violation;
} => {
  const ts = tsApi;
  if (!ts) {
    return {
      wrappedSource: source,
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
      wrappedSource,
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
    wrappedSource,
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

  const ts = tsApi;
  if (!ts) {
    const unavailable = [toAstUnavailableViolation()];
    setCachedAstViolations(cacheKey, unavailable);
    return unavailable;
  }
  const parsed = parseSourceWithTs({ source, context });
  const sourceFile = parsed.sourceFile;
  if (!sourceFile) {
    const unavailable = [toAstUnavailableViolation()];
    setCachedAstViolations(cacheKey, unavailable);
    return unavailable;
  }
  if (parsed.parseError) {
    const parseErrors = [parsed.parseError];
    setCachedAstViolations(cacheKey, parseErrors);
    return parseErrors;
  }

  const out: Violation[] = [];
  const syntaxKind = ts.SyntaxKind;
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
      const { line, column } = toLineColumn(node);
      out.push(
        toAstViolation({
          pattern: "AST-ImportExpression",
          match: "import(...)",
          line,
          column,
        }),
      );
    }
    if (
      n.kind === syntaxKind.MetaProperty &&
      n.keywordToken === syntaxKind.ImportKeyword &&
      n.name?.escapedText === "meta"
    ) {
      const { line, column } = toLineColumn(node);
      out.push(
        toAstViolation({
          pattern: "AST-MetaProperty",
          match: "import.meta",
          line,
          column,
        }),
      );
    }
    if (
      n.kind === syntaxKind.CallExpression &&
      n.expression?.kind === syntaxKind.Identifier &&
      n.expression.escapedText === "require"
    ) {
      const { line, column } = toLineColumn(node);
      out.push(
        toAstViolation({
          pattern: "AST-CallExpression:require",
          match: "require(...)",
          line,
          column,
        }),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  setCachedAstViolations(cacheKey, out);
  return out;
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
  const additional = options?.additionalPatterns ?? [];
  const exclude = new Set(options?.excludePatterns ?? []);
  for (const id of exclude) {
    if (NON_EXCLUDABLE_PATTERN_IDS.has(id)) {
      throw new Error(`strict pattern ${id} cannot be excluded`);
    }
  }
  return validatePatternRegistry([...PATTERN_REGISTRY, ...additional])
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
  const patterns = registry.filter((pattern) => {
    if (context.depth === 0 && pattern.runtimeOnly === true) return false;
    if (context.depth > 0 && pattern.preflightOnly === true) return false;
    return true;
  });

  const lines = source.split("\n");
  const violations: Violation[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      const matches = line.matchAll(pattern.regex);
      for (const match of matches) {
        const violation: Violation = {
          pattern: pattern.id,
          match: match[0]!,
          line: lineIndex + 1,
          column: (match.index ?? 0) + 1,
          category: pattern.category,
          severity: pattern.severity,
        };
        violations.push(violation);
        if (violation.severity === "warn") {
          options?.onWarning?.(violation);
        }
      }
    }
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
  PatternDefinition as PatternDefinition,
  ScanContext as ScanContext,
  ScanResult as ScanResult,
  StrictModeOptions as StrictModeOptions,
  Violation as Violation,
};
