# Browser limitations

`knitting/browser` runs the same pool API over web workers and
`SharedArrayBuffer`. Tasks, typed-array payloads, parallel calls, abort signals,
and shutdown all behave as they do on Node, Deno, and Bun.

This page is the other half: what a page cannot do, what happens when you try,
and why. Everything below was checked against headless Chromium, and every
quoted message is the one the runtime actually produces.

## Two hard requirements

### The page must be cross-origin isolated

Browsers only expose `SharedArrayBuffer` to pages served with both:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without them `createPool` throws:

> SharedArrayBuffer is unavailable: serve the page cross-origin isolated
> (Cross-Origin-Opener-Policy: same-origin, Cross-Origin-Embedder-Policy:
> require-corp).

This is not a knitting policy and cannot be worked around: no shared memory
means no pool. It also constrains the rest of the page — every cross-origin
subresource needs `Cross-Origin-Resource-Policy` or CORS, or the browser refuses
to load it once isolation is on.

### Task modules must call `setModuleUrl(import.meta.url)`

On Node, Deno, and Bun a task discovers its own module by walking the stack.
Bundlers erase the paths that depends on, so in a browser the module has to say
where it lives:

```js
import { setModuleUrl, task } from "knitting/browser";

setModuleUrl(import.meta.url);

export const square = task({ f: (value) => value * value });
```

Without it the worker cannot import the module that defines the tasks.

## Not available in a browser

| Feature                                                              | What happens                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Process workers (`worker.runtime: "process"`, `processRuntime`)      | throws `process workers are unavailable in the browser build`    |
| Compiled / Porffor workers (`runtime: "compiled"`, `.knt` artifacts) | throws `compiled workers are unavailable in the browser build`   |
| `BufferReference`                                                    | throws `BufferReference cannot run in runtime "browser"`         |
| `ProcessSharedBuffer`, named shared memory                           | throws `ProcessSharedBuffer is unavailable in the browser build` |
| Native addons, FFI, file descriptors                                 | unreachable; nothing in a page can load them                     |
| `checkCompiledWorker`                                                | not exported from `knitting/browser`                             |
| Permissions (`permission: {...}`)                                    | **silently ignored** — see below                                 |

All of these need a filesystem, a process to spawn, or FFI. The browser build
replaces them with stubs that raise the errors above rather than failing deeper
in with a confusing one.

### Permissions are inert, and that is a security boundary

The `permission` option is accepted and then skipped entirely. There is no
filesystem to restrict, no process to sandbox, and no runtime flags to pass, so
a strict policy that would constrain a Node worker constrains nothing here.

A web worker runs with the privileges of the page that spawned it: same origin,
same `fetch` reach, same storage. **Task code you would not trust with your
origin must not run in a browser pool.** Isolation there is the browser's job —
a sandboxed iframe on a separate origin — not knitting's.

### `SharedArrayBuffer` as a task argument

This one differs from every other runtime, so it is worth calling out
separately. Passing a `SharedArrayBuffer` _as an argument to a task_ works on
Node, Deno, and Bun, and throws in a browser:

```
KNT_ERROR_3: Unsupported payload type; BufferReference cannot run in runtime "browser"
```

The SAB payload path shares buffers by pinning a process-local pointer through
FFI, which a page cannot do. The pool's own transport is unaffected — that is
how the workers talk at all — this is only about SABs you pass yourself.

Nothing prevents a browser-native path here: SABs are structured-cloneable in a
cross-origin isolated context, so `postMessage` could carry them without any
pointer. It simply is not implemented.

## Behaves differently, but works

- **Workers boot by message, not by `workerData`.** The pool posts the boot
  payload after constructing the worker. Invisible in the API; relevant if you
  are reading worker startup code.
- **`KNITTING_DEBUG` is ignored.** The env gate reads `Deno.env` or
  `process.env`, neither of which exists in a page. Pass the `debug` option to
  `createPool` explicitly instead.
- **`threads` still defaults to 1.** There is no auto-sizing on any runtime; in
  a browser `navigator.hardwareConcurrency` is the number to reach for.
- **Every worker loads the whole bundle.** The worker URL is the bundle's own
  URL, so each thread parses the library again. Memory cost scales with thread
  count.

## Not browser limitations

These fail the same way on Node, so do not go looking for a browser cause:

- `BigInt` payloads — `Do not know how to serialize a BigInt`
- `Map` / `Set` payloads — `Unsupported object type`
- Functions as payloads — `KNT_ERROR_0: Function is not a valid type`
- `Error` values round-trip as `{ name }`, dropping the message

## Where this is tested

The browser lane (`npm run test:browser`) drives headless Chromium through two
layouts — one bundle containing tasks and library, and the standalone
single-file bundle loaded from a script tag next to a separate task module.

**Chromium is the only engine covered.** Firefox and Safari support the same
primitives (workers, `SharedArrayBuffer` under cross-origin isolation) and are
expected to work, but nothing here has been verified against them.

## How the browser build is produced

`knitting/browser` ships as one self-contained minified file (~94 KB, ~32 KB
gzipped). The Node-only subsystems are swapped for stubs at bundle time by
[`scripts/browser-stubs/plugin.ts`](scripts/browser-stubs/plugin.ts); each stub
keeps the behaviour the real module already had in a page — return nothing,
answer false, or throw the message quoted above — which is why the errors in
this document are precise rather than generic.
