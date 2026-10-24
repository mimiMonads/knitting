export const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
};
export const summarize = (runs, expectedRepetitions) => {
  const rows = [];
  const counts = ["published", "local"].map((variant) =>
    runs.filter((run) => run.variant === variant).length
  );
  const complete = counts[0] > 0 && counts[0] === counts[1] &&
    (expectedRepetitions === undefined || counts[0] === expectedRepetitions) &&
    runs.every((run) => run.status === "passed");
  const names = new Set(
    runs.flatMap((run) => Object.keys(run.result?.benchmarks ?? {})),
  );
  for (const name of names) {
    const byVariant = (variant) =>
      runs.filter((run) => run.variant === variant && run.status === "passed")
        .map((run) => run.result.benchmarks[name]?.samplesNs)
        .filter((samples) => samples?.length > 0);
    const baseline = byVariant("published");
    const local = byVariant("local");
    const baselineNs = median(baseline.map(median));
    const localNs = median(local.map(median));
    rows.push({
      name,
      unit: "ns/op",
      publishedRuns: baseline.length,
      localRuns: local.length,
      publishedMedianNs: baselineNs,
      localMedianNs: localNs,
      publishedP99Ns: median(
        baseline.map((samples) => percentile(samples, 0.99)),
      ),
      localP99Ns: median(local.map((samples) => percentile(samples, 0.99))),
      changePercent:
        complete && baseline.length === local.length && baselineNs > 0 &&
          localNs !== null
          ? (localNs / baselineNs - 1) * 100
          : null,
    });
  }
  return { complete, rows };
};
export const renderMarkdown = (metadata, runs) => {
  const summary = summarize(runs, metadata.options.repetitions);
  const complete = summary.complete && !metadata.error;
  const { rows } = summary;
  const number = (value) => value === null ? "—" : value.toFixed(2);
  const lines = [
    "# Knitting release comparison",
    "",
    `Status: **${complete ? "passed" : "incomplete / failed"}**`,
    "",
    `Published: \`knitting@${
      metadata.published?.version ?? "unresolved"
    }\` (requested \`${metadata.options.baseline}\`).`,
    `Local: \`${metadata.git?.commit ?? "unknown"}\`${
      metadata.git?.dirty ? " with working-tree changes" : ""
    }.`,
    `Runtime: ${metadata.environment.node}; ${metadata.environment.platform}/${metadata.environment.arch}.`,
    "",
    "Each version runs in a separate process. Version order alternates between repetitions.",
    "Numbers below are medians of independent run medians; p99 is the median of each run’s p99.",
    "Positive time changes mean local is slower. Performance differences do not fail the check.",
    "",
    "| Workload | Published µs/op | Local µs/op | Change | Published p99 µs | Local p99 µs | Runs published/local |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map((row) =>
      `| ${row.name} | ${
        number(
          row.publishedMedianNs === null ? null : row.publishedMedianNs / 1000,
        )
      } | ${
        number(row.localMedianNs === null ? null : row.localMedianNs / 1000)
      } | ${
        row.changePercent === null ? "—" : row.changePercent.toFixed(1) + "%"
      } | ${
        number(row.publishedP99Ns === null ? null : row.publishedP99Ns / 1000)
      } | ${
        number(row.localP99Ns === null ? null : row.localP99Ns / 1000)
      } | ${row.publishedRuns}/${row.localRuns} |`
    ),
    "",
    "## Correctness",
    "",
    ...runs.map((run) =>
      `- ${run.variant}, repetition ${run.repetition}: **${run.status}**${
        run.error ? ` — ${String(run.error).replaceAll("\n", " ")}` : ""
      }`
    ),
    "",
    "## Memory growth after fresh 1 MiB shared returns",
    "",
    "RSS covers the host and thread workers. GC is requested, but allocator retention and GC timing affect these observations; this is not a leak proof.",
    "",
    "| Version / repetition | Buffers | RSS growth MiB | ArrayBuffer growth MiB |",
    "| --- | ---: | ---: | ---: |",
    ...runs.filter((run) => run.result?.memory?.after).map((run) => {
      const memory = run.result.memory;
      return `| ${run.variant} / ${run.repetition} | ${memory.buffers} | ${
        ((memory.after.rss - memory.before.rss) / 1048576).toFixed(2)
      } | ${
        ((memory.after.arrayBuffers - memory.before.arrayBuffers) / 1048576)
          .toFixed(2)
      } |`;
    }),
    "",
    "## Artifacts and scope",
    "",
    "- `metadata.json`: exact versions, package hashes, environment, options, and source revision.",
    "- `summary.json` and `summary.csv`: machine-readable comparison.",
    "- `runs/`: raw per-operation timings, memory checkpoints, correctness results, stdout, and stderr.",
    "- `packages/`: exact local and published tarballs used by this run.",
    "- `logs/`: package preparation and installation diagnostics.",
    "",
    "Workloads use one trusted Node thread worker and one call in flight. Fresh-buffer timing includes allocation and filling; other payload cases reuse their input. Checksums touch every 4 KiB page and the last byte. Mapping timing includes reading the mapped byte and closing mappings when supported.",
    "This comparison checks shared behavior across releases. Security regressions belong in the local test suite: an older release is expected to fail those tests.",
    "Short runs establish that the harness works. Use repeated runs on an otherwise quiet machine before drawing performance conclusions.",
    "",
  ];
  if (metadata.error) {
    lines.push(
      "## Preparation error",
      "",
      "```text",
      metadata.error,
      "```",
      "",
    );
  }
  return lines.join("\n");
};
