import assert from "node:assert/strict";
import test from "./_runner.ts";
import {
  median,
  renderMarkdown,
  summarize,
} from "../scripts/release-comparison/report.mjs";

const run = (variant: string, samples: number[], repetition = 1) => ({
  variant,
  repetition,
  status: "passed",
  result: { benchmarks: { scalar: { samplesNs: samples } } },
});

test("release comparison weights independent runs equally", () => {
  const summary = summarize([
    run("published", [100, 100, 100]),
    run("published", [300], 2),
    run("local", [200, 200, 200]),
    run("local", [400], 2),
  ], 2);
  assert.equal(summary.complete, true);
  assert.equal(summary.rows[0].publishedMedianNs, 200);
  assert.equal(summary.rows[0].localMedianNs, 300);
  assert.equal(summary.rows[0].changePercent, 50);
  assert.equal(median([]), null);
});

test("failed or missing comparison runs suppress performance claims", () => {
  const published = run("published", [100]);
  const local = {
    ...run("local", [50]),
    status: "failed",
    error: "checksum mismatch",
  };
  for (
    const runs of [[published], [published, local], [
      published,
      run("local", [50]),
    ]]
  ) {
    const summary = summarize(runs, 2);
    assert.equal(summary.complete, false);
    assert.equal(summary.rows[0].changePercent, null);
  }
});

test("comparison reports preserve failures and display timing units correctly", () => {
  const report = renderMarkdown({
    options: { baseline: "latest", repetitions: 1 },
    environment: { node: "v24", platform: "linux", arch: "x64" },
    git: { commit: "abc", dirty: true },
    published: { version: "0.1.77" },
  }, [run("published", [1000]), {
    ...run("local", [500]),
    status: "failed",
    error: "checksum mismatch",
  }]);
  assert.match(report, /incomplete \/ failed/);
  assert.match(report, /checksum mismatch/);
  assert.match(report, /scalar \| 1\.00 \| —/);
  assert.match(report, /working-tree changes/);
});
