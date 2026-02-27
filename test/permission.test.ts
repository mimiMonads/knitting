import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolvePermissionProtocol } from "../src/permission/index.ts";

test("resolvePermissionProtocol returns undefined when disabled", () => {
  assert.equal(resolvePermissionProtocol({}), undefined);
});

test("resolvePermissionProtocol treats legacy off mode as unsafe", () => {
  const resolved = resolvePermissionProtocol({
    permission: "off",
  });

  assert.ok(resolved);
  assert.equal(resolved.mode, "unsafe");
  assert.equal(resolved.unsafe, true);
});

test("resolvePermissionProtocol applies strict defaults from cwd", () => {
  const cwd = process.cwd();
  const home = process.env.HOME ?? process.env.USERPROFILE;
  const isWindows = process.platform === "win32";
  const resolved = resolvePermissionProtocol({
    permission: {},
  });

  assert.ok(resolved);
  assert.equal(resolved.mode, "strict");
  assert.equal(resolved.unsafe, false);
  assert.equal(resolved.allowConsole, false);
  assert.equal(resolved.cwd, cwd);
  assert.equal(resolved.read.includes(cwd), true);
  assert.equal(resolved.write.includes(cwd), true);
  assert.equal(
    resolved.denyRead.includes(path.resolve(cwd, ".env")),
    true,
  );
  assert.equal(
    resolved.denyRead.includes(path.resolve(cwd, ".git")),
    true,
  );
  assert.equal(
    resolved.denyRead.includes(path.resolve(cwd, ".npmrc")),
    true,
  );
  assert.equal(
    resolved.denyRead.includes(path.resolve(cwd, ".docker")),
    true,
  );
  assert.equal(
    resolved.denyRead.includes(path.resolve(cwd, ".secrets")),
    true,
  );
  assert.equal(
    resolved.denyWrite.includes(path.resolve(cwd, "node_modules")),
    true,
  );
  assert.equal(
    resolved.denyWrite.includes(path.resolve(cwd, ".env")),
    true,
  );
  if (typeof home === "string" && home.length > 0) {
    assert.equal(
      resolved.denyRead.includes(path.resolve(home, ".ssh")),
      true,
    );
    assert.equal(
      resolved.denyRead.includes(path.resolve(home, ".gnupg")),
      true,
    );
    assert.equal(
      resolved.denyRead.includes(path.resolve(home, ".aws")),
      true,
    );
    assert.equal(
      resolved.denyRead.includes(path.resolve(home, ".azure")),
      true,
    );
    assert.equal(
      resolved.denyRead.includes(path.resolve(home, ".config/gcloud")),
      true,
    );
    assert.equal(
      resolved.denyRead.includes(path.resolve(home, ".kube")),
      true,
    );
  }
  if (!isWindows) {
    assert.equal(
      resolved.denyRead.includes(path.resolve("/proc")),
      true,
    );
    assert.equal(
      resolved.denyRead.includes(path.resolve("/proc/self")),
      true,
    );
    assert.equal(
      resolved.denyRead.includes(path.resolve("/proc/self/environ")),
      true,
    );
    assert.equal(
      resolved.denyRead.includes(path.resolve("/proc/self/mem")),
      true,
    );
    assert.equal(
      resolved.denyRead.includes(path.resolve("/sys")),
      true,
    );
    assert.equal(
      resolved.denyRead.includes(path.resolve("/dev")),
      true,
    );
    assert.equal(
      resolved.denyRead.includes(path.resolve("/etc")),
      true,
    );
    assert.equal(
      resolved.denyWrite.includes(path.resolve("/etc")),
      false,
    );
  }
  assert.equal(
    resolved.envFiles.includes(path.resolve(cwd, ".env")),
    true,
  );
  assert.equal(
    resolved.lockFiles.deno,
    path.resolve(cwd, "deno.lock"),
  );
  assert.equal(
    resolved.node.flags.includes("--permission") ||
      resolved.node.flags.includes("--experimental-permission"),
    true,
  );
  assert.equal(resolved.node.allowChildProcess, false);
  assert.equal(resolved.deno.allowRun, false);
  assert.equal(resolved.bun.allowRun, false);
  assert.equal(resolved.netAll, false);
  assert.equal(resolved.net.length, 0);
  assert.equal(resolved.allowImport.includes("deno.land"), true);
  assert.equal(resolved.env.allowAll, false);
  assert.equal(resolved.env.allow.length, 0);
  assert.equal(resolved.runAll, false);
  assert.equal(resolved.workers, false);
  assert.equal(resolved.ffiAll, false);
  assert.equal(resolved.sysAll, false);
  assert.equal(resolved.wasi, false);
  assert.deepEqual(resolved.l3.deno, []);
  assert.equal(resolved.l3.node.includes("net"), true);
  assert.equal(resolved.l3.bun.includes("run"), true);
});

test("resolvePermissionProtocol honors explicit read/write lists and custom env files", () => {
  const cwd = process.cwd();
  const home = process.env.HOME ?? process.env.USERPROFILE;
  const fixturePath = path.resolve(cwd, "test/fixtures/runtime_tasks.ts");
  const resolved = resolvePermissionProtocol({
    permission: {
      env: { files: [".env.test"] },
      read: ["README.md"],
      write: ["./tmp-write"],
      denyRead: ["./blocked-read", "~/.private-config"],
      denyWrite: ["./blocked"],
    },
    modules: [pathToFileURL(fixturePath).href],
  });

  assert.ok(resolved);
  assert.equal(
    resolved.read.includes(path.resolve(cwd, "README.md")),
    true,
  );
  assert.equal(
    resolved.read.includes(fixturePath),
    false,
  );
  assert.equal(
    resolved.read.includes(cwd),
    false,
  );
  assert.equal(
    resolved.write.includes(path.resolve(cwd, "tmp-write")),
    true,
  );
  assert.equal(
    resolved.write.includes(cwd),
    false,
  );
  assert.equal(
    resolved.denyRead.includes(path.resolve(cwd, "blocked-read")),
    true,
  );
  if (typeof home === "string" && home.length > 0) {
    assert.equal(
      resolved.denyRead.includes(path.resolve(home, ".private-config")),
      true,
    );
  }
  assert.equal(
    resolved.denyWrite.includes(path.resolve(cwd, "blocked")),
    true,
  );
  assert.equal(
    resolved.envFiles.includes(path.resolve(cwd, ".env.test")),
    true,
  );
});

test("resolvePermissionProtocol custom mode lets explicit deny lists replace strict defaults", () => {
  const cwd = process.cwd();
  const withDefaults = resolvePermissionProtocol({
    permission: { mode: "custom" },
  });
  const custom = resolvePermissionProtocol({
    permission: {
      mode: "custom",
      denyRead: [],
      denyWrite: [],
    },
  });

  assert.ok(withDefaults);
  assert.ok(custom);

  assert.equal(
    withDefaults.denyRead.includes(path.resolve(cwd, ".env")),
    true,
  );
  assert.equal(
    withDefaults.denyWrite.includes(path.resolve(cwd, "node_modules")),
    true,
  );
  assert.equal(
    custom.denyRead.includes(path.resolve(cwd, ".env")),
    false,
  );
  assert.equal(
    custom.denyWrite.includes(path.resolve(cwd, "node_modules")),
    false,
  );
});

test("resolvePermissionProtocol keeps absolute Windows paths", () => {
  if (process.platform !== "win32") return;

  const cwd = process.cwd();
  const absoluteRead = path.resolve(cwd, "README.md");
  const absoluteWrite = path.resolve(cwd, "tmp-write");
  const absoluteDenyRead = path.resolve(cwd, "blocked-read");
  const absoluteDenyWrite = path.resolve(cwd, "blocked-write");
  const absoluteEnv = path.resolve(cwd, ".env.test");
  const resolved = resolvePermissionProtocol({
    permission: {
      read: [absoluteRead],
      write: [absoluteWrite],
      denyRead: [absoluteDenyRead],
      denyWrite: [absoluteDenyWrite],
      env: { files: [absoluteEnv] },
    },
  });

  assert.ok(resolved);
  assert.equal(resolved.read.includes(absoluteRead), true);
  assert.equal(resolved.write.includes(absoluteWrite), true);
  assert.equal(resolved.denyRead.includes(absoluteDenyRead), true);
  assert.equal(resolved.denyWrite.includes(absoluteDenyWrite), true);
  assert.equal(resolved.envFiles.includes(absoluteEnv), true);
});

test("resolvePermissionProtocol supports unsafe mode shorthand", () => {
  const resolved = resolvePermissionProtocol({
    permission: "unsafe",
  });

  assert.ok(resolved);
  assert.equal(resolved.mode, "unsafe");
  assert.equal(resolved.unsafe, true);
  assert.equal(resolved.allowConsole, true);
  assert.equal(resolved.readAll, true);
  assert.equal(resolved.writeAll, true);
  assert.equal(resolved.netAll, true);
  assert.equal(resolved.env.allowAll, true);
  assert.equal(resolved.runAll, true);
  assert.equal(resolved.ffiAll, true);
  assert.equal(resolved.sysAll, true);
  assert.equal(resolved.workers, true);
  assert.equal(resolved.wasi, true);
  assert.equal(resolved.denyRead.length, 0);
  assert.equal(resolved.denyWrite.length, 0);
  assert.equal(resolved.node.flags.length, 0);
  assert.equal(resolved.node.allowChildProcess, true);
  assert.equal(resolved.deno.allowRun, true);
  assert.equal(resolved.bun.allowRun, true);
});

test("resolvePermissionProtocol allows explicit console in strict mode", () => {
  const resolved = resolvePermissionProtocol({
    permission: { mode: "strict", console: true },
  });

  assert.ok(resolved);
  assert.equal(resolved.mode, "strict");
  assert.equal(resolved.allowConsole, true);
});

test("resolvePermissionProtocol allows explicit process execution in strict mode", () => {
  const resolved = resolvePermissionProtocol({
    permission: {
      mode: "strict",
      node: { allowChildProcess: true },
      deno: { allowRun: true },
      bun: { allowRun: true },
    },
  });

  assert.ok(resolved);
  assert.equal(resolved.mode, "strict");
  assert.equal(resolved.node.allowChildProcess, true);
  assert.equal(resolved.deno.allowRun, true);
  assert.equal(resolved.bun.allowRun, true);
  assert.equal(resolved.runAll, true);
});

test("resolvePermissionProtocol derives node booleans from top-level unified fields", () => {
  const cwd = process.cwd();
  const resolved = resolvePermissionProtocol({
    permission: {
      mode: "custom",
      run: ["node"],
      workers: true,
      ffi: [path.resolve(cwd, "native-addon.node")],
      wasi: true,
    },
  });

  assert.ok(resolved);
  assert.equal(resolved.mode, "custom");
  assert.equal(resolved.runAll, false);
  assert.equal(resolved.run.includes("node"), true);
  assert.equal(resolved.workers, true);
  assert.equal(resolved.ffiAll, false);
  assert.equal(resolved.ffi.includes(path.resolve(cwd, "native-addon.node")), true);
  assert.equal(resolved.wasi, true);
  assert.equal(resolved.node.allowChildProcess, true);
  assert.equal(resolved.node.allowWorker, true);
  assert.equal(resolved.node.allowAddons, true);
  assert.equal(resolved.node.allowWasi, true);
  assert.equal(resolved.node.flags.includes("--allow-child-process"), true);
  assert.equal(resolved.node.flags.includes("--allow-worker"), true);
  assert.equal(resolved.node.flags.includes("--allow-addons"), true);
  assert.equal(resolved.node.flags.includes("--allow-wasi"), true);
});

test("resolvePermissionProtocol emits deno flags for unified categories", () => {
  const resolved = resolvePermissionProtocol({
    permission: {
      mode: "custom",
      read: true,
      write: [".", "./tmp"],
      net: ["api.example.com:443"],
      denyNet: ["127.0.0.1:1"],
      allowImport: ["jsr.io"],
      env: {
        allow: ["NODE_ENV"],
        deny: ["AWS_SECRET_ACCESS_KEY"],
        files: [".env.production"],
      },
      run: ["curl"],
      denyRun: ["bash"],
      ffi: true,
      denyFfi: ["./blocked-ffi.so"],
      sys: ["hostname"],
      denySys: ["uid"],
    },
  });

  assert.ok(resolved);
  assert.equal(resolved.deno.flags.some((flag) => flag === "--allow-read"), true);
  assert.equal(
    resolved.deno.flags.some((flag) => flag.startsWith("--allow-write=")),
    true,
  );
  assert.equal(
    resolved.deno.flags.some((flag) => flag === "--allow-net=api.example.com:443"),
    true,
  );
  assert.equal(
    resolved.deno.flags.some((flag) => flag === "--deny-net=127.0.0.1:1"),
    true,
  );
  assert.equal(
    resolved.deno.flags.some((flag) => flag === "--allow-import=jsr.io"),
    true,
  );
  assert.equal(
    resolved.deno.flags.some((flag) => flag === "--allow-env=NODE_ENV"),
    true,
  );
  assert.equal(
    resolved.deno.flags.some((flag) => flag === "--deny-env=AWS_SECRET_ACCESS_KEY"),
    true,
  );
  assert.equal(
    resolved.deno.flags.some((flag) => flag.includes("--env-file=") && flag.includes(".env.production")),
    true,
  );
  assert.equal(
    resolved.deno.flags.some((flag) => flag === "--allow-run=curl"),
    true,
  );
  assert.equal(
    resolved.deno.flags.some((flag) => flag === "--deny-run=bash"),
    true,
  );
  assert.equal(
    resolved.deno.flags.some((flag) => flag === "--allow-ffi"),
    true,
  );
  assert.equal(
    resolved.deno.flags.some((flag) => flag.startsWith("--deny-ffi=")),
    true,
  );
  assert.equal(
    resolved.deno.flags.some((flag) => flag === "--allow-sys=hostname"),
    true,
  );
  assert.equal(
    resolved.deno.flags.some((flag) => flag === "--deny-sys=uid"),
    true,
  );
});

test("resolvePermissionProtocol resolves strict scan defaults", () => {
  const resolved = resolvePermissionProtocol({
    permission: { mode: "strict" },
  });

  assert.ok(resolved);
  assert.equal(resolved.strict.recursiveScan, true);
  assert.equal(resolved.strict.maxEvalDepth, 16);
  assert.equal(resolved.strict.sandbox, false);
});

test("resolvePermissionProtocol clamps strict.maxEvalDepth and accepts recursiveScan=false", () => {
  const resolved = resolvePermissionProtocol({
    permission: {
      mode: "strict",
      strict: {
        recursiveScan: false,
        maxEvalDepth: 999,
        sandbox: true,
      },
    },
  });

  assert.ok(resolved);
  assert.equal(resolved.strict.recursiveScan, false);
  assert.equal(resolved.strict.maxEvalDepth, 64);
  assert.equal(resolved.strict.sandbox, true);
});
