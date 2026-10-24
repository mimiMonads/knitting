# knitting

[![JSR Version](https://jsr.io/badges/@vixeny/knitting)](https://jsr.io/@vixeny/knitting)
[![npm Version](https://img.shields.io/npm/v/knitting?logo=npm&logoColor=white)](https://www.npmjs.com/package/knitting)
[![Tests](https://github.com/mimiMonads/knitting/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/mimiMonads/knitting/actions/workflows/test.yml)
[![Coverage Workflow](https://github.com/mimiMonads/knitting/actions/workflows/coverage.yml/badge.svg?branch=main)](https://github.com/mimiMonads/knitting/actions/workflows/coverage.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

Knitting is a worker pool for Node.js, Deno, and Bun, with a focus on HTTP servers
and request offloading. It runs JavaScript and TypeScript functions in threads or
separate processes. Calls use shared memory, and results come back as promises.

Website: [js.knitting.run](https://js.knitting.run/)

For agents, the website provides a compact documentation map in
[`llms.txt`](https://js.knitting.run/llms.txt) and full documentation in
[`llms-full.txt`](https://js.knitting.run/llms-full.txt).

Knitting specializes in:

- Offloading CPU-heavy work from HTTP request handlers.
- Parsing and validating request bodies.
- Server-side rendering and compression.
- Sharing large buffers between workers.
- Running tasks across threads and processes.

[Documentation](https://js.knitting.run/) · [API guide](docs/guide.md) · [Source map](map.md) · [Discord](https://discord.gg/qUguPADQnT)

## Install

```sh
npm install knitting
```

For Deno, use `deno add --npm knitting`.

## Example

Save this as `example.mjs`:

```js
import { createPool, isMain } from "knitting";

export const square = (value) => value * value;
export const greet = (name) => `hello ${name}`;

if (isMain) {
  const pool = createPool({ threads: 2 })({ square, greet });

  try {
    const [four, message] = await Promise.all([
      pool.call.square(2),
      pool.call.greet("knitting"),
    ]);
    console.log({ four, message });
  } finally {
    await pool.shutdown();
  }
}
```

Run it with Node.js, Bun, or Deno:

```sh
node example.mjs
bun example.mjs
deno run -A example.mjs
```

The result is `{ four: 4, message: "hello knitting" }`.

Export your functions so workers can load them. Keep pool creation inside
`if (isMain)` so workers don't create pools of their own. Call `shutdown()` when
you're done; `finally` makes sure it also runs if a task fails.

This example works on Node.js 22. Runtimes with `await using` can use it for
cleanup instead; see [pool cleanup](docs/guide.md#the-mental-model).
Deno's `-A` grants all permissions for the example.

## Features

- Typed function calls across threads and processes.
- Timeouts and cancellation.
- JSON, typed arrays, and shared buffers.
- Work stealing and scheduling options.
- [Browser support](BROWSER.md) for pages with cross-origin isolation enabled.

See the [API guide](docs/guide.md) for configuration and experimental backends.

## Runtime support

Knitting requires Node.js 22+, Deno 2+, or Bun 1+.
The [test workflow](https://github.com/mimiMonads/knitting/actions/workflows/test.yml)
covers Linux, macOS, and Windows; check it for tested versions and results.

Node.js native addons are packaged for 22 and 24 on Linux x64, macOS x64/arm64,
and Windows x64. Node.js 26 has an experimental FFI backend. See
[native support](docs/guide.md#platform-and-native-support) for details.

Permissions depend on the runtime and worker type. Read the
[permission guide](docs/guide.md#permissions) when setting up process isolation.

## Benchmarks

Shared memory can reduce the cost of sending work to a worker. How much it helps
depends on the task, payload, runtime, and pool settings.

```sh
./run.sh --json --bench=doorbell --runtime=node
```

See the [benchmarks](https://github.com/mimiMonads/knitting/blob/main/bench/README.md)
for commands, measurements, and reports. Compare repeated runs with the same
settings, and test your own workload before drawing conclusions.

## Development

Bun runs the build scripts. Install Node.js and Deno too if you want to test all
three runtimes.

```sh
bun install --frozen-lockfile
bun run build
npm run test:node
npm run test:bun
npm run test:deno
```

See [Contributing](https://github.com/mimiMonads/knitting/blob/main/CONTRIBUTING.md)
for native builds, browser tests, and pull requests. Report security issues using
the [security policy](https://github.com/mimiMonads/knitting/blob/main/SECURITY.md).

## License

[Apache-2.0](LICENSE).
