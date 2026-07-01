import assert from "node:assert/strict";
import test from "./_runner.ts";
import {
  classifyProcessPermissionCompatibility,
  enforceProcessPermissionCompatibility,
  resolvePermissionProtocol,
} from "../src/permission/index.ts";
import type {
  PermissionProtocolInput,
  ProcessPermissionTarget,
} from "../src/permission/index.ts";

const reportFor = (
  permission: PermissionProtocolInput | undefined,
  target: ProcessPermissionTarget,
) => {
  const resolved = resolvePermissionProtocol({
    permission: permission ?? { mode: "strict", allowImport: true },
  });
  return classifyProcessPermissionCompatibility({
    permission,
    resolved,
    target,
  });
};

const explicitCheck = (
  permission: PermissionProtocolInput,
  target: ProcessPermissionTarget,
  name: string,
) => {
  const check = reportFor(permission, target).checks.find((entry) =>
    entry.permission === name && entry.explicit
  );
  assert.ok(check, `missing explicit compatibility check for ${name}`);
  return check;
};

test("Deno process workers exactly represent scoped network permissions", () => {
  const check = explicitCheck(
    { mode: "strict", net: ["api.example.com:443"] },
    { runtime: "deno" },
    "net",
  );

  assert.equal(check.level, "exact");
});

test("Node 24 rejects network restrictions it cannot represent", () => {
  const check = explicitCheck(
    { mode: "strict", net: ["api.example.com:443"] },
    { runtime: "node", nodeMajor: 24 },
    "net",
  );

  assert.equal(check.level, "unsupported");
});

test("Node 26 distinguishes deny-all from an unrepresentable host allow-list", () => {
  const denyAll = explicitCheck(
    { mode: "strict", net: [] },
    { runtime: "node", nodeMajor: 26 },
    "net",
  );
  const scoped = explicitCheck(
    { mode: "strict", net: ["api.example.com:443"] },
    { runtime: "node", nodeMajor: 26 },
    "net",
  );

  assert.equal(denyAll.level, "exact");
  assert.equal(scoped.level, "coarse");
});

test("Node process workers reject scoped child-process allow-lists", () => {
  const check = explicitCheck(
    { mode: "strict", run: ["node"] },
    { runtime: "node", nodeMajor: 24 },
    "run",
  );

  assert.equal(check.level, "coarse");
});

test("Bun process workers reject explicit filesystem restrictions", () => {
  const check = explicitCheck(
    { mode: "strict", read: ["./data"] },
    { runtime: "bun" },
    "read",
  );

  assert.equal(check.level, "unsupported");
});

test("native transport exemptions make explicit FFI denial unenforceable", () => {
  for (
    const target of [
      { runtime: "deno" },
      { runtime: "node", nodeMajor: 24 },
      { runtime: "node", nodeMajor: 26 },
    ] as const
  ) {
    const check = explicitCheck(
      { mode: "strict", ffi: false },
      target,
      "ffi",
    );
    assert.equal(check.level, "unsupported");
  }
});

test("Node transport keeps addon and node:ffi overrides independent", () => {
  const node24Addons = explicitCheck(
    { mode: "strict", node: { allowAddons: false } },
    { runtime: "node", nodeMajor: 24 },
    "node.allowAddons",
  );
  const node24Ffi = explicitCheck(
    { mode: "strict", node: { allowFfi: false } },
    { runtime: "node", nodeMajor: 24 },
    "node.allowFfi",
  );
  const node26Addons = explicitCheck(
    { mode: "strict", node: { allowAddons: false } },
    { runtime: "node", nodeMajor: 26 },
    "node.allowAddons",
  );
  const node26Ffi = explicitCheck(
    { mode: "strict", node: { allowFfi: false } },
    { runtime: "node", nodeMajor: 26 },
    "node.allowFfi",
  );

  assert.equal(node24Addons.level, "unsupported");
  assert.equal(node24Ffi.level, "exact");
  assert.equal(node26Addons.level, "exact");
  assert.equal(node26Ffi.level, "unsupported");
});

test("implicit strict compatibility gaps warn while explicit gaps fail closed", () => {
  const implicit = reportFor(undefined, {
    runtime: "node",
    nodeMajor: 24,
  });
  assert.equal(
    implicit.checks.some((check) => check.level !== "exact" && check.explicit),
    false,
  );

  const explicit = reportFor(
    { mode: "strict", net: ["api.example.com"] },
    { runtime: "node", nodeMajor: 24 },
  );
  assert.throws(
    () => enforceProcessPermissionCompatibility(explicit),
    /permission\.net is unsupported/i,
  );
});

test("empty deny lists do not turn strict defaults into explicit failures", () => {
  const report = reportFor(
    { mode: "strict", denyRead: [], denyWrite: [] },
    { runtime: "node", nodeMajor: 24 },
  );

  assert.equal(
    report.checks.some((check) =>
      (check.permission === "denyRead" ||
        check.permission === "denyWrite") &&
      check.explicit
    ),
    false,
  );
});
