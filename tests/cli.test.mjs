import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(root, "dist", "cli.js");
const fixture = path.join(root, "tests", "fixtures", "badapp");

test("cli audits fixture and finds sync I/O + in-process session", () => {
  const r = spawnSync(process.execPath, [cli, fixture], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.ok(typeof report.score === "number");
  const ids = report.findings.map((f) => f.id);
  assert.ok(ids.includes("sync-io"), "expected sync-io finding");
  assert.ok(ids.includes("in-process-session"), "expected in-process-session finding");
});

test("cli renders markdown and supports --fail-on exit codes", () => {
  const md = spawnSync(process.execPath, [cli, fixture, "--format", "md"], { encoding: "utf8" });
  assert.equal(md.status, 0, md.stderr);
  assert.match(md.stdout, /# Scale-Readiness Report/);

  const failHigh = spawnSync(process.execPath, [cli, fixture, "--fail-on", "high"], { encoding: "utf8" });
  assert.equal(failHigh.status, 2);

  const failCritical = spawnSync(process.execPath, [cli, fixture, "--fail-on", "critical"], { encoding: "utf8" });
  assert.equal(failCritical.status, 0);
});

test("--diff prints a unified diff with automated fixes and never touches the repo", () => {
  const unbounded = path.join(root, "tests", "fixtures", "unboundedapp");
  const r = spawnSync(process.execPath, [cli, unbounded, "--diff"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^--- a\/src\/server\.js/m, "expected a unified diff header");
  assert.match(r.stdout, /^\+.*take: 50/m, "expected an injected pagination key");
  assert.ok(!r.stdout.includes('"findings"'), "diff mode must not print the JSON report");

  // The fixture must be untouched: --diff only prints.
  const original = spawnSync(process.execPath, [cli, unbounded], { encoding: "utf8" });
  const after = JSON.parse(original.stdout);
  assert.ok(after.findings.some((f) => f.id === "unbounded-read"), "fixture should still have unbounded reads");
});

test("--fix applies automated fixes in place", () => {
  const unbounded = path.join(root, "tests", "fixtures", "unboundedapp");
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "scale-audit-fix-"));
  try {
    fs.cpSync(unbounded, copy, { recursive: true });
    const r = spawnSync(process.execPath, [cli, copy, "--fix"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const patched = fs.readFileSync(path.join(copy, "src", "server.js"), "utf8");
    assert.match(patched, /take: 50/, "expected pagination to be injected");
    // And the finding should be gone after the fix.
    const after = JSON.parse(spawnSync(process.execPath, [cli, copy], { encoding: "utf8" }).stdout);
    assert.ok(!after.findings.some((f) => f.id === "unbounded-read"), "unbounded read should be resolved");
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test("--fix refuses to run against a remote URL", () => {
  const r = spawnSync(process.execPath, [cli, "https://github.com/owner/repo", "--fix"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /only works on a local path/);
});

test("the generated patch is a valid unified diff that git apply accepts", () => {
  const unbounded = path.join(root, "tests", "fixtures", "unboundedapp");
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "scale-audit-patch-"));
  try {
    fs.cpSync(unbounded, copy, { recursive: true });
    const r = spawnSync(process.execPath, [cli, copy, "--diff"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);

    // Proper hunk headers, not a whole-file dump.
    assert.match(r.stdout, /^@@ -\d+,\d+ \+\d+,\d+ @@/m);

    const patchFile = path.join(copy, "fix.patch");
    fs.writeFileSync(patchFile, r.stdout, "utf8");
    const check = spawnSync("git", ["apply", "--check", patchFile], { cwd: copy, encoding: "utf8" });
    assert.equal(check.status, 0, `git apply --check failed: ${check.stderr}`);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test("score is family-capped so one repeated issue class does not zero it out", () => {
  const scoring = path.join(root, "tests", "fixtures", "scoring");
  const r = spawnSync(process.execPath, [cli, scoring], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.findings.length, 12, "expected 12 sync-io findings");
  assert.ok(report.findings.every((f) => f.id === "sync-io"));
  // 12 high-severity findings = 120 raw penalty, capped at 20 for the family -> 80.
  assert.equal(report.score, 80);
});