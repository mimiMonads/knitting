declare const Bun: {
  argv: string[];
  env: Record<string, string | undefined>;
  build: (options: {
    entrypoints: string[];
    outdir: string;
    format: "esm";
    target: "node" | "browser";
    define?: Record<string, string>;
    minify?: {
      syntax?: boolean;
      whitespace?: boolean;
      identifiers?: boolean;
    };
  }) => Promise<{ success: boolean; logs: unknown[] }>;
};

const isWebBuild = Bun.argv.includes("--web") ||
  Bun.env.KNITTING_BUILD_TARGET === "web" ||
  Bun.env.KNITTING_BUILD_TARGET === "browser";

const result = await Bun.build({
  entrypoints: ["./knitting.ts"],
  outdir: "./out",
  format: "esm",
  target: isWebBuild ? "browser" : "node",
  define: isWebBuild
    ? {
      "globalThis.__KNITTING_BROWSER_BUILD__": "true",
    }
    : undefined,
  minify: isWebBuild
    ? {
      syntax: true,
      whitespace: false,
      identifiers: false,
    }
    : undefined,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
