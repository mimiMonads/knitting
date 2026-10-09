import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCompiledWorker, createPool } from "../knitting.ts";
import { addOne } from "./fixtures/loop_tasks.ts";
import test from "./_runner.ts";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
  COMPILED_WORKER_FORMAT_VERSION,
  inspectCompiledWorkerArtifact,
} from "../src/runtime/compiled-artifact.ts";

const fingerprint = (source: string) => ({
  source,
  sha256: createHash("sha256").update(readFileSync(fileURLToPath(source)))
    .digest("hex"),
});

const runtimeTarget = (): { platform: string; arch: string } => {
  const runtime = globalThis as typeof globalThis & {
    Deno?: { build?: { os?: string; arch?: string } };
    process?: { platform?: string; arch?: string };
  };
  const arch = String(
    runtime.process?.arch ?? runtime.Deno?.build?.arch ?? "unknown",
  );
  return {
    platform: runtime.process?.platform ?? runtime.Deno?.build?.os ?? "unknown",
    arch: arch === "x86_64" ? "x64" : arch === "aarch64" ? "arm64" : arch,
  };
};

const fakeCompiledWorker = [
  "#!/usr/bin/env node",
  "const { readSync, writeSync } = require('node:fs');",
  "const request = Buffer.alloc(16);",
  "const response = Buffer.alloc(16);",
  "while (true) {",
  "  let offset = 0;",
  "  while (offset < 16) {",
  "    const count = readSync(0, request, offset, 16 - offset, null);",
  "    if (count === 0) process.exit(0);",
  "    offset += count;",
  "  }",
  "  const task = request.readInt32LE(0);",
  "  if (task === -1) break;",
  "  response.fill(0);",
  "  response.writeInt32LE(task === 0 ? 0 : 1, 0);",
  "  response.writeDoubleLE(request.readDoubleLE(8) + 1, 8);",
  "  writeSync(1, response);",
  "}",
  "",
].join("\n");

const fakeJsonCompiledWorker = [
  "#!/usr/bin/env node",
  "const { readSync, writeSync } = require('node:fs');",
  "const readExact = (length) => {",
  "  const output = Buffer.alloc(length);",
  "  let offset = 0;",
  "  while (offset < length) {",
  "    const count = readSync(0, output, offset, length - offset, null);",
  "    if (count === 0) process.exit(0);",
  "    offset += count;",
  "  }",
  "  return output;",
  "};",
  "while (true) {",
  "  const header = readExact(12);",
  "  const task = header.readInt32LE(0);",
  "  if (task === -1) break;",
  "  const input = JSON.parse(readExact(header.readUInt32LE(8)).toString());",
  "  const payload = Buffer.from(JSON.stringify(input));",
  "  const response = Buffer.alloc(8);",
  "  response.writeInt32LE(task === 0 ? 0 : 1, 0);",
  "  response.writeUInt32LE(payload.length, 4);",
  "  writeSync(1, response);",
  "  writeSync(1, payload);",
  "}",
  "",
].join("\n");

test("compiled/Porffor workers keep their transport under the stealing default", async () => {
  if (runtimeTarget().platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "knitting-compiled-"));
  const artifact = join(dir, "loop_tasks.knt");
  try {
    writeFileSync(artifact, fakeCompiledWorker);
    chmodSync(artifact, 0o755);
    writeFileSync(
      artifact + ".json",
      JSON.stringify({
        format: "knitting-compiled-worker",
        version: COMPILED_WORKER_FORMAT_VERSION,
        protocol: "knitting-number-v1",
        compiler: { name: "fixture", version: "1" },
        target: runtimeTarget(),
        source: addOne.importedFrom,
        inputs: [fingerprint(addOne.importedFrom)],
        tasks: [{ index: 0, exportName: "addOne" }],
      }),
    );

    const check = checkCompiledWorker(addOne, { artifact });
    assert.equal(check.compiled, true, check.reason);
    assert.equal(check.artifact, artifact);
    assert.deepEqual(check.tasks, ["addOne"]);

    const pool = createPool({
      threads: 2,
      worker: {
        runtime: "compiled",
        processRuntime: "porffor",
        compiled: { artifact },
      },
    })({ addOne });
    try {
      assert.deepEqual(
        await Promise.all([
          pool.call.addOne(1),
          pool.call.addOne(10),
          pool.call.addOne(Promise.resolve(41)),
        ]),
        [2, 11, 42],
      );
      await assert.rejects(
        pool.call.addOne("wrong" as never),
        /only accepts a number/,
      );
    } finally {
      await pool.shutdown();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compiled worker checks fail without executing bad artifacts", () => {
  const automatic = checkCompiledWorker(addOne);
  assert.match(automatic.artifact, /loop_tasks\.knt$/);
  assert.match(automatic.manifest, /loop_tasks\.knt\.json$/);

  const check = checkCompiledWorker(addOne, {
    artifact: "./definitely-missing.knt",
  });
  assert.equal(check.compiled, false);
  assert.match(check.reason ?? "", /artifact is unavailable/);
});

test("compiled JSON workers round-trip objects and primitives", async () => {
  if (runtimeTarget().platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "knitting-compiled-json-"));
  const artifact = join(dir, "loop_tasks.knt");
  try {
    writeFileSync(artifact, fakeJsonCompiledWorker);
    chmodSync(artifact, 0o755);
    writeFileSync(
      artifact + ".json",
      JSON.stringify({
        format: "knitting-compiled-worker",
        version: COMPILED_WORKER_FORMAT_VERSION,
        protocol: "knitting-json-v1",
        compiler: { name: "fixture", version: "1" },
        target: runtimeTarget(),
        source: addOne.importedFrom,
        inputs: [fingerprint(addOne.importedFrom)],
        tasks: [{ index: 0, exportName: "echo" }],
      }),
    );

    const pool = createPool({
      worker: {
        runtime: "compiled",
        compiled: { artifact, build: false },
      },
    })({ echo: addOne });
    try {
      const values = [
        "Héllo",
        true,
        null,
        [1, "two", false],
        { id: 7, nested: { ready: true } },
        JSON.parse(
          '{"__proto__":{"marker":123},"constructor":7,"nested":{"__proto__":null}}',
        ),
      ];
      for (const value of values) {
        assert.deepEqual(await pool.call.echo(value as never), value);
      }
      await assert.rejects(
        pool.call.echo("🌍" as never),
        /do not yet support non-BMP Unicode/,
      );
    } finally {
      await pool.shutdown();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compiled worker build can be disabled", () => {
  assert.throws(
    () =>
      createPool({
        worker: {
          runtime: "compiled",
          compiled: {
            artifact: "./definitely-missing.knt",
            build: false,
          },
        },
      })({ addOne }),
    /Compiled worker is unavailable/,
  );
});

test("compiled worker checks report malformed manifests", () => {
  if (runtimeTarget().platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "knitting-compiled-bad-"));
  const artifact = join(dir, "bad.knt");
  try {
    writeFileSync(artifact, fakeCompiledWorker);
    chmodSync(artifact, 0o755);
    writeFileSync(artifact + ".json", "null");
    const check = checkCompiledWorker(addOne, { artifact });
    assert.equal(check.compiled, false);
    assert.match(check.reason ?? "", /manifest root must be an object/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compiled worker checks detect a stale task module", () => {
  if (runtimeTarget().platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "knitting-compiled-stale-"));
  const artifact = join(dir, "loop_tasks.knt");
  try {
    writeFileSync(artifact, fakeCompiledWorker);
    chmodSync(artifact, 0o755);
    writeFileSync(
      artifact + ".json",
      JSON.stringify({
        format: "knitting-compiled-worker",
        version: COMPILED_WORKER_FORMAT_VERSION,
        protocol: "knitting-number-v1",
        compiler: { name: "fixture", version: "1" },
        target: runtimeTarget(),
        source: addOne.importedFrom,
        inputs: [fingerprint(addOne.importedFrom)],
        sourceMtimeMs: 0,
        tasks: [{ index: 0, exportName: "addOne" }],
      }),
    );
    const check = checkCompiledWorker(addOne, { artifact });
    assert.equal(check.compiled, false);
    assert.match(check.reason ?? "", /task module changed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compiled worker rejects unsupported pool features before spawning", () => {
  assert.throws(
    () =>
      createPool({
        inliner: { position: "first" },
        worker: { runtime: "compiled" },
      })({ addOne }),
    /Compiled workers do not support: inliner/,
  );
});

test("processRuntime porffor selects the compiled backend", () => {
  assert.throws(
    () =>
      createPool({
        inliner: { position: "first" },
        worker: { processRuntime: "porffor" },
      })({ addOne }),
    /Compiled workers do not support: inliner/,
  );
});

test("processRuntime porffor rejects conflicting runtimes", () => {
  assert.throws(
    () =>
      createPool({
        worker: { runtime: "thread", processRuntime: "porffor" },
      })({ addOne }),
    /requires worker.runtime to be compiled or omitted/,
  );
});

test("compiled workers reject changed dependency contents without timestamp metadata", () => {
  if (runtimeTarget().platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "knitting-compiled-inputs-"));
  const artifact = join(dir, "tasks.knt");
  const source = join(dir, "tasks.ts");
  const helper = join(dir, "helper.ts");
  try {
    writeFileSync(source, "export const echo = (n: number) => n;");
    writeFileSync(helper, "export const delta = 1;");
    writeFileSync(artifact, fakeCompiledWorker);
    chmodSync(artifact, 0o755);
    const sourceHref = pathToFileURL(source).href;
    const helperHref = pathToFileURL(helper).href;
    const manifest = {
      format: "knitting-compiled-worker",
      version: COMPILED_WORKER_FORMAT_VERSION,
      protocol: "knitting-json-v1",
      compiler: "fixture",
      target: runtimeTarget(),
      source: sourceHref,
      inputs: [fingerprint(sourceHref), fingerprint(helperHref)],
      tasks: [{ index: 0, exportName: "echo" }],
    };
    const check = () =>
      inspectCompiledWorkerArtifact({
        source: sourceHref,
        options: { artifact },
      });
    writeFileSync(artifact + ".json", JSON.stringify(manifest));
    assert.equal(check().compiled, true);
    writeFileSync(helper, "export const delta = 2;");
    assert.match(check().reason!, /compiled input changed/);
    writeFileSync(helper, "export const delta = 1;");
    assert.equal(check().compiled, true);
    rmSync(helper);
    assert.match(check().reason!, /compiled input is unavailable/);
    manifest.inputs = [];
    writeFileSync(artifact + ".json", JSON.stringify(manifest));
    assert.match(check().reason!, /no input fingerprints/);
    manifest.version = 1;
    writeFileSync(artifact + ".json", JSON.stringify(manifest));
    assert.match(check().reason!, /unsupported manifest format/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compiled child stdin failure rejects calls without crashing the host", {
  timeout: 10_000,
}, async () => {
  if (runtimeTarget().platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "knitting-compiled-pipe-"));
  const artifact = join(dir, "closed-input.knt");
  const probe = join(dir, "probe.mjs");
  try {
    // Keep stdout/process alive after closing stdin so the stream error, rather
    // than the exit handler, is what rejects the queued writes.
    writeFileSync(
      artifact,
      "#!/usr/bin/env node\nrequire('node:fs').closeSync(0); setTimeout(() => {}, 500);\n",
    );
    chmodSync(artifact, 0o755);
    writeFileSync(
      artifact + ".json",
      JSON.stringify({
        format: "knitting-compiled-worker",
        version: COMPILED_WORKER_FORMAT_VERSION,
        protocol: "knitting-json-v1",
        compiler: "fixture",
        target: runtimeTarget(),
        source: addOne.importedFrom,
        inputs: [fingerprint(addOne.importedFrom)],
        tasks: [{ index: 0, exportName: "echo" }],
      }),
    );
    writeFileSync(
      probe,
      `
      import { spawnCompiledWorkerContext } from ${
        JSON.stringify(
          new URL("../src/runtime/compiled-worker.ts", import.meta.url).href,
        )
      };
      const context = spawnCompiledWorkerContext({
        list: [${JSON.stringify(addOne.importedFrom)}], names: ['echo'],
        workerOptions: { compiled: { artifact: ${
        JSON.stringify(artifact)
      }, build: false } },
      });
      const call = context.call({fnNumber: 0});
      try {
        const results = await Promise.allSettled(Array.from({length: 20}, () => call('x'.repeat(128 * 1024))));
        if (results.some(result => result.status !== 'rejected')) throw new Error('Expected all writes to reject');
      } finally { await context.kills(); }
    `,
    );
    const child = spawn("node", [
      "--no-warnings",
      "--experimental-transform-types",
      probe,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => stderr += chunk);
    const code = await new Promise<number | null>((resolve, reject) => {
      // Deno's node:child_process declarations omit inherited EventEmitter methods.
      const events = child as unknown as {
        on: (event: string, listener: (...args: any[]) => void) => void;
      };
      events.on("error", reject);
      events.on("exit", resolve);
    });
    assert.equal(code, 0, stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
