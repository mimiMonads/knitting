# Contributing

Bug fixes, docs, and tests are welcome. For a large change, open an issue first
so we can discuss it before you spend time on a pull request.

## Getting started

Install Node.js 22 or 24, Bun, and Deno 2. Bun runs the build scripts.
Use the versions in [CI](.github/workflows/test.yml) when investigating a test
failure. Node 22 needs to support `--experimental-transform-types` for the tests.

```sh
git clone https://github.com/mimiMonads/knitting.git
cd knitting
bun install --frozen-lockfile
bun run build
```

Run `deno install` if you're working with Deno. The [source map](map.md) is a good
place to start reading the code. Edit the TypeScript sources; the build generates
JavaScript and declarations.

## Testing

Run the tests for the runtimes your change affects:

```sh
npm run test:node
npm run test:bun
npm run test:deno
```

`npm test` runs Deno only. `npm run test:all` also runs browser tests, which need
Chrome or Chromium. Set `KNITTING_CHROMIUM` if the browser isn't on PATH.
Without a browser, those tests are skipped.

Add regression tests in `test/`. Browser tests live in `test/browser/`.
For native changes, run `bun run build:native` with a C++ toolchain installed.
See [native support](docs/guide.md#platform-and-native-support) for supported
platforms and flags, including the separate Node 26 FFI test.

## Sending a pull request

Explain what changed, why, and how you tested it. Mention any platforms or
runtimes you couldn't check. Update the [API guide](docs/guide.md) if behavior
changes, and include a regression test for bug fixes where practical.

For performance changes, include a reproducible benchmark, runtime versions,
hardware, commands, and results. Follow the [benchmark guide](bench/README.md).
For shared-memory or native changes, explain how memory and handles are cleaned
up and whether permissions are affected.

Report vulnerabilities through [Security](SECURITY.md).
Maintainers can use the [release checklist](docs/releases.md) when publishing.
