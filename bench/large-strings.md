# Large strings across Node, Deno and Bun

The experiment now has two C++ backends and an ordinary-string caller adapter.
Node uses V8 directly; Deno and Bun use Node-API. The adapter sends native
storage through knitting's existing external-payload framing and transport
holds. Worker task functions receive primitive strings. No new public type or
production default is added.

## Run

Build with Node 24, matching headers, and a C++20 compiler. Headers next to the
running Node executable are used unless `NODE_INCLUDE_DIR` is set. The V8 addon
is tied to the Node ABI; the Node-API addon is shared by the three tested
runtimes. The build helper currently supports Linux/macOS.

```sh
node bench/native/build-string-reference.mjs
node --expose-gc --experimental-transform-types --no-warnings \
  bench/native/large-strings.ts --json
deno run -A --v8-flags=--expose-gc bench/native/large-strings.ts --json
bun bench/native/large-strings.ts --json
```

Run the repeatable comparison, sequentially across all runtimes:

```sh
node bench/native/run-large-strings.mjs
```

The driver defaults to three independent runs per runtime and workload. Sampled
reads use 500 timed rounds and 150 warmup rounds; full scans use 100 and 50. It
validates native reclamation before publishing each capture and writes
`results/large-strings/cross-runtime/summary.json`. `STRING_NODE_BINARY`,
`STRING_DENO_BINARY`, and `STRING_BUN_BINARY` select executable paths.
`RUNTIMES=node,deno,bun`, `WORKLOADS=sample,scan`, `REPETITIONS`, and
`STRING_RESULTS_DIR` control the driver.

For direct runs, `SIZES` now defaults to **1024, 65536, 1048576 UTF-8 bytes**.
Fixtures contain whole repeated patterns plus ASCII padding to reach the exact
byte count. Different encodings therefore have different JS `.length` values;
these are byte-for-byte payload size comparisons, not equal-character-count
comparisons. `SIZE_UNIT=codeUnits` reproduces the earlier character-count
experiment. `KINDS=ascii,latin1,utf16,emoji`, `ROUNDS`, `WARMUP`, and
`WORKLOAD=sample|scan` select the remaining parameters. `STRING_BACKEND=napi`
can test the portable backend on Node, and `STRING_BACKEND=v8` selects the
Node-only optimized backend.

`VARIANTS=plain-string,native-transparent` is the primary comparison. The driver
uses exactly those variants. Both accept an existing ordinary string. Native
preparation, JSON metadata framing, transport holds, receiver adoption, and
sender disposal are all included in the native call latency. Variant order
rotates each round. Fixture creation, host validation, and post-case GC/draining
are excluded. The checksums are verified on every call. One worker and one call
in flight keep the comparison small; p10/p50/p90 are captured for every case.

## Implemented variants

| Variant                 | Work included per call                                                             |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `plain-string`          | Existing knitting UTF-8 string codec                                               |
| `native-transparent`    | Internal native storage, real codec framing/holds, ordinary worker string          |
| `native-auto-64k`       | Candidate policy: use native when `.length * 2 >= 65536`, otherwise existing codec |
| `native-fresh-external` | Fresh native storage, raw bigint token, receiver adoption, sender release          |
| `native-reuse-external` | Existing native storage, raw token, receiver adoption                              |
| `native-fresh-copy`     | Fresh native storage, raw token, copy into receiver heap                           |
| `native-reuse-copy`     | Existing native storage, raw token, receiver heap copy                             |
| `sab-fresh-decode`      | Encode into fresh SAB, send, decode                                                |
| `sab-reuse-decode`      | Send existing SAB, decode                                                          |
| `moved-utf8-decode`     | Encode, BufferReference move, decode, release                                      |

The default direct run includes the first seven. Raw-token/reused variants are
controls, not evidence that automatic transport is free. Rows record external
and copied adoption counts so a runtime's copy fallback is visible. The
candidate 64 KiB policy is deliberately simple, not a recommended default:
UTF-16 size differs from UTF-8 size, and ASCII and Unicode have different
crossovers. An automatic codec would need its own policy and broader validation.

## Backends and ownership

`native/string-reference.cc` uses Node/V8 `IsOneByte()` to select Latin-1 or
UTF-16 storage without an extra scan. `native/string-reference-napi.cc` copies
UTF-16 code units through Node-API, preserving lone surrogates and avoiding a
speculative ASCII classification scan. Both allocate uninitialized character
arrays that the native string-copy APIs fully populate, avoiding an unnecessary
zero-fill pass. No raw address or writable view escapes.

A producer registry owns immutable character storage through a `shared_ptr`.
Each adopted external string gets an independent shared-pointer owner. Sender
release drops the registry hold, not the receiver's storage. The cleanup hook
removes registry entries belonging to a terminating producer. An adopted string
can outlive the original producer and the call that delivered it. The string's
GC finalizer drops its own owner. A copy fallback runs that finalizer
immediately. Lookup and cleanup use the registry mutex; storage destruction
happens outside it. Releasing before adoption produces a checked error rather
than a dangling pointer.

The Node-API module reports API version 9 for Deno 2.7 compatibility and
declares the external UTF-16 entry point that was experimental before API
version 10. All tested runtimes export that function. Older runtimes without the
symbol cannot load this experimental backend; production use needs capability
checks.

The installed runtimes behave differently:

- **Node 24.19.0:** the V8 backend creates external Latin-1/UTF-16 strings.
- **Deno 2.7.4:** its
  [external-string API copies](https://github.com/denoland/deno/blob/v2.7.4/ext/napi/js_native_api.rs).
  It still avoids UTF-8 conversion, but receiver adoption is not zero-copy.
  Newer Deno source has a zero-copy implementation; it is not measured here.
- **Bun 1.4.0:** its
  [Node-API backend creates JavaScriptCore external strings](https://github.com/oven-sh/bun/blob/bun-v1.4.0/src/jsc/bindings/napi.cpp).
  Its finalizer callbacks are queued. A synchronous knitting worker must yield
  to its event loop to drain them. The benchmark collects and yields between
  cases and before shutdown; these cleanup intervals are outside call timing.

The Bun detail matters for an automatic default: repeated synchronous calls can
accumulate retired character storage even after sender handles are released.
Simply forcing GC synchronously does not drain those callbacks. A production
backend needs bounded retirement and cooperative draining, or a copied fallback.
This benchmark is not a claim that this work has no memory or cleanup cost.

## Lifetime verification

```sh
node --expose-gc bench/native/string-reference-lifetime.mjs
deno run -A --v8-flags=--expose-gc bench/native/string-reference-lifetime.mjs
bun bench/native/string-reference-lifetime.mjs

node --expose-gc --experimental-transform-types --no-warnings \
  bench/native/string-transport-lifetime.ts
deno run -A --v8-flags=--expose-gc bench/native/string-transport-lifetime.ts
bun bench/native/string-transport-lifetime.ts
```

The native probe checks exact code units, embedded NULs, lone surrogates,
duplicate/invalid release, multiple adopted strings, sender release while the
receiver retains its string, and producer teardown while another receiver
retains its string. The transport probe verifies ordinary worker strings,
retention after call settlement and GC, queued calls, task errors, synchronous
send errors, and automatic-policy fallback. Both require zero registry entries
and zero native character bytes after collection. Bun consumer collection
includes event-loop turns before teardown.

## Results

The tables below are generated from three independent runs on local Linux x64 on
2026-10-09. Values are the median of run medians, in microseconds. They compare
existing string calls with the fully framed `native-transparent` path and use
exact UTF-8 payload bytes. Native paths include fresh character allocation and
sender release. The original one-million-code-unit raw-token results are kept in
earlier local captures; they are not directly comparable to these tables.

### 1 KiB: sampled reads

| Runtime      | Text   | Current µs | Native µs | Current / native |
| ------------ | ------ | ---------: | --------: | ---------------: |
| node 24.19.0 | ascii  |        9.2 |      17.6 |            0.52× |
| node 24.19.0 | latin1 |        4.1 |       6.6 |            0.63× |
| node 24.19.0 | utf16  |        5.3 |       6.7 |            0.79× |
| node 24.19.0 | emoji  |        5.1 |       5.9 |            0.87× |
| deno 2.7.4   | ascii  |       22.1 |      29.3 |            0.75× |
| deno 2.7.4   | latin1 |       23.6 |      24.3 |            0.97× |
| deno 2.7.4   | utf16  |       22.7 |      19.2 |            1.18× |
| deno 2.7.4   | emoji  |       21.5 |      17.3 |            1.25× |
| bun 1.4.0    | ascii  |        7.9 |      14.4 |            0.55× |
| bun 1.4.0    | latin1 |        7.9 |       7.3 |            1.08× |
| bun 1.4.0    | utf16  |        7.2 |       8.9 |            0.81× |
| bun 1.4.0    | emoji  |        4.5 |       6.4 |            0.71× |

### 64 KiB: sampled reads

| Runtime      | Text   | Current µs | Native µs | Current / native |
| ------------ | ------ | ---------: | --------: | ---------------: |
| node 24.19.0 | ascii  |       20.9 |      44.8 |            0.47× |
| node 24.19.0 | latin1 |       68.6 |      13.0 |            5.26× |
| node 24.19.0 | utf16  |      103.7 |      32.3 |            3.21× |
| node 24.19.0 | emoji  |      143.5 |      13.1 |           10.97× |
| deno 2.7.4   | ascii  |       26.8 |      38.7 |            0.69× |
| deno 2.7.4   | latin1 |      237.2 |      43.1 |            5.50× |
| deno 2.7.4   | utf16  |      394.0 |      31.9 |           12.35× |
| deno 2.7.4   | emoji  |      424.0 |      30.5 |           13.89× |
| bun 1.4.0    | ascii  |       17.3 |      52.2 |            0.33× |
| bun 1.4.0    | latin1 |      179.5 |      42.8 |            4.19× |
| bun 1.4.0    | utf16  |       34.2 |      28.5 |            1.20× |
| bun 1.4.0    | emoji  |       36.6 |      29.2 |            1.25× |

### 1 MiB: sampled reads

| Runtime      | Text   | Current µs | Native µs | Current / native |
| ------------ | ------ | ---------: | --------: | ---------------: |
| node 24.19.0 | ascii  |      245.3 |      87.0 |            2.82× |
| node 24.19.0 | latin1 |     1263.1 |     154.1 |            8.20× |
| node 24.19.0 | utf16  |     1943.5 |     103.3 |           18.80× |
| node 24.19.0 | emoji  |     2640.3 |     113.2 |           23.32× |
| deno 2.7.4   | ascii  |      311.2 |     522.1 |            0.60× |
| deno 2.7.4   | latin1 |     3662.5 |     600.4 |            6.10× |
| deno 2.7.4   | utf16  |     6041.2 |     351.0 |           17.21× |
| deno 2.7.4   | emoji  |     6546.7 |     366.2 |           17.88× |
| bun 1.4.0    | ascii  |      157.4 |     651.6 |            0.24× |
| bun 1.4.0    | latin1 |     2776.8 |     552.7 |            5.02× |
| bun 1.4.0    | utf16  |      453.6 |     371.1 |            1.22× |
| bun 1.4.0    | emoji  |      472.3 |     390.4 |            1.21× |

### 1 MiB: full character scan

| Runtime      | Text   | Current µs | Native µs | Current / native |
| ------------ | ------ | ---------: | --------: | ---------------: |
| node 24.19.0 | ascii  |     2643.9 |    2428.8 |            1.09× |
| node 24.19.0 | latin1 |     2610.3 |    1959.0 |            1.33× |
| node 24.19.0 | utf16  |     4596.1 |    2711.9 |            1.69× |
| node 24.19.0 | emoji  |     3442.9 |    1046.2 |            3.29× |
| deno 2.7.4   | ascii  |     2232.7 |    2533.5 |            0.88× |
| deno 2.7.4   | latin1 |     5019.8 |    1960.1 |            2.56× |
| deno 2.7.4   | utf16  |     6750.4 |    1133.6 |            5.95× |
| deno 2.7.4   | emoji  |     7297.5 |    1159.8 |            6.29× |
| bun 1.4.0    | ascii  |      871.6 |    1541.2 |            0.57× |
| bun 1.4.0    | latin1 |     3342.4 |    1179.1 |            2.83× |
| bun 1.4.0    | utf16  |     1068.9 |    1008.7 |            1.06× |
| bun 1.4.0    | emoji  |     1127.7 |    1049.4 |            1.07× |

A ratio above 1 means native is faster. At 1 KiB the native path usually loses;
the small Deno Unicode gains do not justify a universal native small-string
default. At 64 KiB and 1 MiB, Latin-1/Unicode/emoji generally win, but ASCII
loses at 64 KiB on all runtimes and at 1 MiB on Deno and Bun. The Bun Unicode
benefit is modest, especially for a full scan; its Latin-1 benefit is larger.
Node gains at 1 MiB ASCII as well. A threshold alone is insufficient.

Full scans greatly reduce many of the transport gains. This is why the raw token
result should not be treated as an application speedup.

The report uses one Unicode fixture and one Latin-1 fixture, not every possible
string representation. Node uses its optimized V8 backend; Deno/Bun use the
portable UTF-16 backend. For example, the latter widens ASCII to UTF-16, which
helps explain why a native default is not uniformly beneficial.

The raw JSON captures contain p10/p90 and the summary contains the min/max of
each run median. All 18 captures passed content validation, recorded the
expected external/copy behavior, and ended with zero registry entries and zero
native character bytes after post-case cleanup and post-run collection.
GC/finalizer draining is excluded from call latency; Bun specifically needs
those event-loop turns, so the tables are not a measure of amortized retirement
cost under unlimited sustained load.

## Default-behavior decision

The measured recommendation is to keep the existing codec for small strings, and
investigate automatic native dispatch for large non-ASCII text. At the tested
sizes, Node also benefits for 1 MiB ASCII; the portable Deno/Bun backend does
not. Do not use a uniform 64 KiB threshold: it regresses ASCII, and the
UTF-16-based candidate misses some 64 KiB UTF-8 Unicode inputs. Content or
representation classification has its own cost, which the forced native-path
comparison does not include. Measure that policy before adopting a default.

The experiment provides a working ordinary-string route with different native
backends. It does not enable a global native default. Adoption behavior, string
representation, small-message overhead, and Bun's finalizer queue must all be
part of that decision. The full-scan workload shows how much transport gains
remain when the worker actually visits every code unit.

Before automatic use, measure cancellation/worker failure under load, memory
pressure and cleanup overhead, multiple workers, result-string transport, and
parser/regex workloads. Native support should be feature-detected and restricted
to same-process threads until a mapped-memory owner is implemented for process
workers. Small strings and unsupported platforms should retain the current
codec. An explicit reusable text handle can still offer a separate benefit by
amortizing producer preparation, but it is not needed to expose ordinary strings
to worker functions.
