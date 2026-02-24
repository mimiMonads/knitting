import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolvePermisonProtocol } from "../src/permison/index.ts";

test("resolvePermisonProtocol returns undefined when disabled", () => {
  assert.equal(resolvePermisonProtocol({}), undefined);
});

test("resolvePermisonProtocol treats legacy off mode as unsafe", () => {
  const resolved = resolvePermisonProtocol({
    permission: "off" as unknown as "unsafe",
  });

  assert.ok(resolved);
  assert.equal(resolved.mode, "unsafe");
  assert.equal(resolved.unsafe, true);
});

test("resolvePermisonProtocol applies strict defaults from cwd", () => {
  const cwd = process.cwd();
  const home = process.env.HOME ?? process.env.USERPROFILE;
  const isWindows = process.platform === "win32";
  const resolved = resolvePermisonProtocol({
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
});

test("resolvePermisonProtocol includes module read paths and custom env files", () => {
  const cwd = process.cwd();
  const home = process.env.HOME ?? process.env.USERPROFILE;
  const fixturePath = path.resolve(cwd, "test/fixtures/runtime_tasks.ts");
  const resolved = resolvePermisonProtocol({
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

test("resolvePermisonProtocol supports unsafe mode shorthand", () => {
  const resolved = resolvePermisonProtocol({
    permission: "unsafe",
  });

  assert.ok(resolved);
  assert.equal(resolved.mode, "unsafe");
  assert.equal(resolved.unsafe, true);
  assert.equal(resolved.allowConsole, true);
  assert.equal(resolved.denyRead.length, 0);
  assert.equal(resolved.denyWrite.length, 0);
  assert.equal(resolved.node.flags.length, 0);
});

test("resolvePermisonProtocol allows explicit console in strict mode", () => {
  const resolved = resolvePermisonProtocol({
    permission: { mode: "strict", console: true },
  });

  assert.ok(resolved);
  assert.equal(resolved.mode, "strict");
  assert.equal(resolved.allowConsole, true);
});
