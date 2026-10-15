import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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

test("--verify patches unbounded reads in an isolated copy and reports per-file validity", () => {
  const unbounded = path.join(root, "tests", "fixtures", "unboundedapp");
  const r = spawnSync(process.execPath, [cli, unbounded, "--verify"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  const auto = report.verification.filter((v) => v.findingId === "unbounded-read");
  assert.ok(auto.length >= 2, "expected at least 2 auto-verifiable findings");
  assert.ok(auto.every((v) => v.patchApplied === true), JSON.stringify(auto));
  assert.ok(auto.every((v) => v.validity === 100), JSON.stringify(auto));

  // The original fixture must be untouched (verify works on a temp copy).
  const original = spawnSync(process.execPath, [cli, unbounded], { encoding: "utf8" });
  const after = JSON.parse(original.stdout);
  assert.ok(after.findings.some((f) => f.id === "unbounded-read"), "fixture should still have unbounded reads");
});