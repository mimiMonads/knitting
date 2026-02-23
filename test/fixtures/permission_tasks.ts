import path from "node:path";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { task } from "../../knitting.ts";

export const writeIntoNodeModules = task<void, string>({
  f: () => {
    const output = path.resolve(
      process.cwd(),
      "node_modules",
      ".knitting-permission-probe.tmp",
    );
    writeFileSync(output, "blocked");
    return output;
  },
});

export const writeIntoCwd = task<void, string>({
  f: () => {
    const output = path.resolve(
      process.cwd(),
      ".knitting-permission-allowed.tmp",
    );
    writeFileSync(output, "ok");
    return output;
  },
});

export const readGitDirectory = task<void, number>({
  f: () => {
    const gitDir = path.resolve(process.cwd(), ".git");
    return readdirSync(gitDir).length;
  },
});

export const readReadme = task<void, string>({
  f: () => {
    const readmePath = path.resolve(process.cwd(), "README.md");
    return readFileSync(readmePath, "utf8");
  },
});

export const tamperPerformanceNow = task<void, {
  sample: number;
  stableSample: number;
  changedToZero: boolean;
  replacedObject: boolean;
}>({
  f: () => {
    const stableNow = performance.now.bind(performance);
    let changedToZero = false;
    let replacedObject = false;
    try {
      (performance as unknown as { now: () => number }).now = () => 0;
      changedToZero = performance.now() === 0;
    } catch {
      changedToZero = false;
    }
    try {
      (globalThis as { performance: { now: () => number } }).performance = {
        now: () => 0,
      };
      replacedObject = performance.now() === 0;
    } catch {
      replacedObject = false;
    }
    return {
      sample: performance.now(),
      stableSample: stableNow(),
      changedToZero,
      replacedObject,
    };
  },
});
