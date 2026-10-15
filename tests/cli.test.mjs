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