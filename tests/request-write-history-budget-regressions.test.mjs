import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AnalysisBudget } from "../dist/analysisBudget.js";
import { detectSyncIo } from "../dist/detectors/syncIo.js";
import { runAudit } from "../dist/runner.js";

async function withSource(source, run) {
  const root = await mkdtemp(join(tmpdir(), "scale-request-write-history-"));
  try {
    await writeFile(join(root, "server.ts"), source);
    return await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

const header = `import { createServer } from 'node:http'; import { readFileSync } from 'node:fs';
  function live() { readFileSync('live'); } function quiet() {}`;
for (const [name, source, expected] of [
  ["final module write becomes live", "let task = quiet; task = live; createServer(() => task());", 1],
  ["final module write becomes quiet", "let task = live; task = quiet; createServer(() => task());", 0],
  ["local writes are selected at the call position", "createServer(() => { let task = quiet; task = live; task(); task = quiet; task(); });", 1],
  ["future local writes cannot replace an earlier call", "createServer(() => { let task = quiet; task(); task = live; });", 0],
  ["a module alias captures the earlier value", "let task = quiet; const captured = task; task = live; createServer(() => captured());", 0],
  ["an alias preserves the earlier live value", "let task = live; const captured = task; task = quiet; createServer(() => captured());", 1],
  ["conditional writes remain uncertain", "let task = live; if (flag) task = quiet; createServer(() => task());", 0],
  ["writes from another callable remain uncertain", "let task = live; function update() { task = quiet; } createServer(() => task());", 0],
  ["multiple callable scopes remain uncertain", "let task = live; function update() { task = quiet; } createServer(() => { task = live; task(); });", 0],
]) {
  test(`indexed request writes preserve timing: ${name}`, async () => {
    const findings = await withSource(header + source, detectSyncIo);
    assert.equal(findings.filter(finding => finding.id === "sync-io" && finding.severity === "high").length, expected);
  });
}

test("wide DI registration reads reuse write histories within unchanged request limits", async () => {
  const work = [];
  for (const count of [125, 250]) {
    const entries = Array.from({ length: count }, (_, index) =>
      `container.register('db${index}', { useFactory: () => new PrismaClient() }, { lifecycle: scope });`).join("\n");
    const reads = Array.from({ length: count }, (_, index) => `container.resolve('db${index}');`).join("\n");
    const source = `import { PrismaClient } from '@prisma/client'; import { container, Lifecycle } from 'tsyringe';
      let scope = Lifecycle.Transient; ${"scope = Lifecycle.Singleton;".repeat(count)}
      ${entries} export function GET() { ${reads} }`;
    const take = AnalysisBudget.prototype.take;
    let charged = 0;
    AnalysisBudget.prototype.take = function (units = 1) {
      if (this.label === "Request reachability") charged += units;
      return take.call(this, units);
    };
    try {
      const report = await withSource(source, runAudit);
      assert.equal(report.complete, true);
      assert.ok(report.detectors.every(detector => detector.status === "complete"));
      assert.equal(report.findings.filter(finding => finding.category === "Connection").length, 0);
      work.push(charged);
    } finally { AnalysisBudget.prototype.take = take; }
  }
  assert.ok(work[1] < work[0] * 2.3, `write history lookup should grow near linearly: ${work}`);
});
