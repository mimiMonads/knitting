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
    permission: "off" as unknown as "unsafe",
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
  }
  assert.equal(
    resolved.envFiles.includes(path.resolve(cwd, ".env")),
    false,
  );
  assert.equal(
    resolved.lockFiles.deno,
    path.resolve(cwd, "deno.lock"),
  );
  assert.equal(
    resolved.node.flags.includes("--permission"),
    true,
  );
  assert.equal(resolved.node.allowChildProcess, false);
  assert.equal(resolved.deno.allowRun, false);
  assert.equal(resolved.bun.allowRun, false);
});

test("resolvePermissionProtocol includes module read paths and custom env files", () => {
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
    true,
  );
  assert.equal(
    resolved.write.includes(path.resolve(cwd, "tmp-write")),
    true,
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
