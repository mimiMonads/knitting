import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createPool, isMain, task } from "../../../knitting.ts";

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`test timeout after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
};

export const readFileSnippet = task<string, string>({
  f: (filePath) => readFileSync(filePath, "utf8").slice(0, 200),
});

const defaultTarget = (() => {
  const gitConfig = path.resolve(process.cwd(), ".git", "config");
  if (existsSync(gitConfig)) {
    return gitConfig;
  }
  if (process.platform === "win32") {
    const root = process.env.WINDIR ?? "C:\\Windows";
    return path.resolve(root, "System32", "drivers", "etc", "hosts");
  }
  return "/etc/hosts";
})();

const target = process.argv[2] ?? process.env.KNT_PROBE_TARGET ?? defaultTarget;

if (isMain) {
  const strictPool = createPool({
    threads: 1,
    permission: "strict",
  })({ readFileSnippet });

  const unsafePool = createPool({
    threads: 1,
    permission: "unsafe",
  })({ readFileSnippet });

  try {
    let strictBlocked = false;
    try {
      await withTimeout(strictPool.call.readFileSnippet(target), 1_500);
    } catch (error) {
      const text = String(error);
      strictBlocked = text.includes("KNT_ERROR_PERMISSION_DENIED") ||
        text.includes("ERR_ACCESS_DENIED");
    }

    if (!strictBlocked) {
      console.error("probe-strict-missing-block", target);
      process.exit(2);
    }

    const snippet = await withTimeout(unsafePool.call.readFileSnippet(target), 1_500);
    if (typeof snippet !== "string" || snippet.length === 0) {
      console.error("probe-unsafe-read-failed", target);
      process.exit(3);
    }

    console.log("probe-ok strict-blocked-unsafe-read", target);
    console.log(snippet);
    process.exit(0);
  } finally {
    await Promise.allSettled([
      strictPool.shutdown(),
      unsafePool.shutdown(),
    ]);
  }
}
