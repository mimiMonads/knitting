# Experimental StringReference round trips

Measured on this Linux x64 machine with Node 24.19.0, Deno 2.7.4, and Bun 1.4.0.
These are actual host → thread worker → host string round trips through knitting's
public experimental API, using the production Node-API addon with compact ASCII storage.

Each cell is median latency in microseconds (lower is better): the median of
three independent runs' p50 measurements. Each run has 30 warmups followed by
100 calls per case, one worker and one in-flight call. Size is exact UTF-8 input
bytes: 1 KiB = 1,024, 64 KiB = 65,536, 1 MiB = 1,048,576. Native storage uses
one byte per ASCII code unit and two bytes per code unit for other text, so its
allocation size depends on the character set.

- **Plain:** the worker returns the primitive string it receives.
- **Shared:** the host constructs a fresh `StringReference`; the worker
  materializes it and returns a clone sharing the original character allocation.
  The host materializes the returned reference and releases both wrappers.
- **Rebuilt:** the worker materializes the input and constructs a new
  `StringReference` for the return. This includes a second character copy/allocation.

Reference timings include construction, both wire directions, worker materialization,
host materialization, and explicit host releases. Full exact equality checks occur
outside the timed interval. Worker inputs are explicitly released. Returned worker
wrappers have a GC backstop; collection and Bun finalizer queue draining happen
between cases, outside timing. These measurements therefore do not include all GC
pause costs. GC eventually frees external storage after materialized strings die.
The harness ends with zero registry handles **and zero live native bytes** on all
nine runs. It also tests empty strings, embedded NULs, lone surrogates, cloning
after source release, 24 concurrent calls, task errors, and reading a returned
reference after worker shutdown.

The earlier [large-string experiment](large-strings.md) measured one-way sampled
reads, and Node used a V8 backend with compact Latin-1 storage. This implementation
uses the same ABI-stable Node-API backend on all three runtimes, with compact
ASCII storage and UTF-16 for other text. These
round-trip timings must be compared with their own plain baseline.

## node 24.19.0

| UTF-8 bytes | Characters | Plain µs | Shared µs | Rebuilt µs | Plain/shared |
|---|---|---:|---:|---:|---:|
| 1 KiB | ascii | 24.48 | 54.91 | 47.76 | 0.45× |
| 1 KiB | latin1 | 19.77 | 31.18 | 30.88 | 0.63× |
| 1 KiB | utf16 | 13.78 | 34.22 | 35.51 | 0.40× |
| 1 KiB | emoji | 17.72 | 26.87 | 26.77 | 0.66× |
| 64 KiB | ascii | 46.56 | 56.69 | 89.47 | 0.82× |
| 64 KiB | latin1 | 117.12 | 64.21 | 106.97 | 1.82× |
| 64 KiB | utf16 | 187.10 | 49.80 | 79.59 | 3.76× |
| 64 KiB | emoji | 271.77 | 34.26 | 82.42 | 7.93× |
| 1 MiB | ascii | 672.57 | 540.14 | 1105.65 | 1.25× |
| 1 MiB | latin1 | 2580.89 | 528.27 | 1239.80 | 4.89× |
| 1 MiB | utf16 | 3975.53 | 446.89 | 836.52 | 8.90× |
| 1 MiB | emoji | 5118.58 | 444.94 | 852.98 | 11.50× |

## deno 2.7.4

| UTF-8 bytes | Characters | Plain µs | Shared µs | Rebuilt µs | Plain/shared |
|---|---|---:|---:|---:|---:|
| 1 KiB | ascii | 39.27 | 53.81 | 66.85 | 0.73× |
| 1 KiB | latin1 | 40.72 | 40.21 | 39.15 | 1.01× |
| 1 KiB | utf16 | 40.96 | 43.97 | 38.53 | 0.93× |
| 1 KiB | emoji | 32.07 | 34.63 | 32.51 | 0.93× |
| 64 KiB | ascii | 38.32 | 68.77 | 92.51 | 0.56× |
| 64 KiB | latin1 | 441.30 | 98.71 | 101.35 | 4.47× |
| 64 KiB | utf16 | 769.51 | 66.46 | 73.94 | 11.58× |
| 64 KiB | emoji | 887.30 | 62.28 | 65.90 | 14.25× |
| 1 MiB | ascii | 698.41 | 785.32 | 1032.49 | 0.89× |
| 1 MiB | latin1 | 7217.59 | 1362.52 | 1580.37 | 5.30× |
| 1 MiB | utf16 | 11771.45 | 826.55 | 952.82 | 14.24× |
| 1 MiB | emoji | 12941.26 | 816.58 | 934.68 | 15.85× |

## bun 1.4.0

| UTF-8 bytes | Characters | Plain µs | Shared µs | Rebuilt µs | Plain/shared |
|---|---|---:|---:|---:|---:|
| 1 KiB | ascii | 18.47 | 35.83 | 28.93 | 0.52× |
| 1 KiB | latin1 | 14.05 | 24.88 | 29.65 | 0.56× |
| 1 KiB | utf16 | 14.54 | 34.25 | 25.80 | 0.42× |
| 1 KiB | emoji | 12.87 | 18.11 | 20.28 | 0.71× |
| 64 KiB | ascii | 70.23 | 39.87 | 69.48 | 1.76× |
| 64 KiB | latin1 | 247.21 | 48.55 | 84.15 | 5.09× |
| 64 KiB | utf16 | 111.98 | 22.68 | 32.19 | 4.94× |
| 64 KiB | emoji | 85.29 | 20.46 | 31.03 | 4.17× |
| 1 MiB | ascii | 391.63 | 437.50 | 922.35 | 0.90× |
| 1 MiB | latin1 | 3414.10 | 535.17 | 1264.59 | 6.38× |
| 1 MiB | utf16 | 985.62 | 371.14 | 518.01 | 2.66× |
| 1 MiB | emoji | 1074.45 | 408.09 | 524.60 | 2.63× |

## ASCII fast path

Previously every ASCII input was widened to UTF-16. The addon now probes the
first 64 code units to reject obvious non-ASCII text, then copies candidate
ASCII directly into a one-byte buffer and validates **all copied bytes**. A
truncated or non-ASCII copy falls back to the original UTF-16 extraction.
This preserves embedded NULs, supplementary characters and lone surrogates,
including non-ASCII content after a long ASCII prefix.

Materialization uses [Node-API external Latin-1 strings](https://nodejs.org/api/n-api.html#node_api_create_external_string_latin1)
for ASCII and external UTF-16 strings for other text. Actual copy/adoption
behavior still depends on the runtime. ASCII character storage is halved;
`byteLength` now equals `length` for ASCII and `length * 2` otherwise.

Fresh 1 MiB ASCII shared round trips, comparing three-run medians collected
before and after the change in the same session:

| Runtime | UTF-16 before µs | Compact ASCII after µs | Before/after |
|---|---:|---:|---:|
| node 24.19.0 | 797.37 | 540.14 | 1.48× |
| deno 2.7.4 | 1704.96 | 785.32 | 2.17× |
| bun 1.4.0 | 770.62 | 437.50 | 1.76× |

Classification is included in these timings. Obvious non-ASCII text uses a
bounded probe; text with a long ASCII prefix can incur a failed one-byte copy
before UTF-16 extraction. This optimization is ASCII-specific; Latin-1 content
above U+007F still uses UTF-16. Other fixtures retain their large gains over
plain transport, but individual before/after medians vary (the 1 MiB UTF-16
shared case changed from 404.89 to 446.89 µs on Node and from 723.17 to
826.55 µs on Deno). These are short sequential runs, not confidence intervals.

## Reusing an existing reference

For repeated calls with the same contents, construct the source reference once
and return a worker clone. An additional three-run ASCII measurement adds
**Reused**, which performs the same worker and host materialization as Shared
but excludes initial source construction from each timed call. Every returned
wrapper is still released; the source is released after its case.

| Runtime, 1 MiB ASCII | Plain µs | Fresh shared µs | Rebuilt µs | Reused µs |
|---|---:|---:|---:|---:|
| node 24.19.0 | 791.40 | 495.54 | 1151.05 | 54.18 |
| deno 2.7.4 | 672.79 | 791.08 | 1034.99 | 283.72 |
| bun 1.4.0 | 328.09 | 471.52 | 983.01 | 27.16 |

These are separate captures from the main tables, so their plain/fresh timings
differ. Reuse amortizes the initial copy/allocation; it does not make producing
new string contents cheaper. Deno still copies on each materialization.

```ts
const source = new StringReference(text);
try {
  for (let i = 0; i < 100; i++) {
    const output = await pool.call.echoReference(source);
    try { consume(output.toString()); }
    finally { output.release(); }
  }
} finally {
  source.release();
}
```

## Interpretation

At 1 KiB, wrapping generally costs more than ordinary string transport. Compact
ASCII substantially improves larger references, but a fresh wrapper still loses
to plain ASCII in several cases. Preserve a reference across calls when the
contents are reusable, and use `clone()` for an unchanged return value.

Every main run reported 6,296 external adoptions on Node and Bun, and zero copied
adoptions. Deno reported 6,296 copied adoptions and zero external adoptions.
All nine main runs and all nine reuse runs ended with zero registry handles and
zero live native bytes. GC/finalizer draining remains outside call timing.

Keep the type explicit and experimental. Size alone does not establish whether
references win: content, runtime, reuse, materialization and memory retention
all affect the result. Ordinary strings retain their existing behavior.

## Reproduce

Use a supported Node version and Bun on PATH for the native/build scripts:

```sh
npm run build:native
npm run build
node bench/native/run-string-reference-roundtrip.mjs
```

The runner invokes Node with `--experimental-transform-types --expose-gc`, Deno
with `run -A --v8-flags=--expose-gc`, and Bun normally. Select executable paths
with `STRING_NODE_BINARY`, `STRING_DENO_BINARY`, and `STRING_BUN_BINARY`.
Configure `ROUNDS`, `WARMUP`, `REPETITIONS`, `RUNTIMES`, `MODES`, `KINDS`, or `STRING_RESULTS_DIR`
as needed. Raw captures and summaries are written to the ignored local directory
`results/string-reference-roundtrip/`; captures include p90, actual adoption counts,
and final native-memory totals. Failures stop the runner before updating summary.

To reproduce the additional ASCII reuse comparison:

```sh
KINDS=ascii MODES=plain,shared,rebuilt,reused \
  STRING_RESULTS_DIR=results/string-reference-ascii-reuse \
  node bench/native/run-string-reference-roundtrip.mjs
```

```sh
node --experimental-transform-types --test test/string-reference.test.ts test/payloadCodec.test.ts
deno test -A test/string-reference.test.ts test/payloadCodec.test.ts
bun test test/string-reference.test.ts test/payloadCodec.test.ts
```

The standalone benchmark requires its native addon and never silently skips.
Unit tests mark StringReference tests skipped when no native addon has been built.
Browser, process, compiled, and cross-runtime transport are outside this API's
scope; only native thread workers in the same process/runtime are supported.
