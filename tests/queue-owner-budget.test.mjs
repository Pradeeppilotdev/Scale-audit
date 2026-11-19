import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";

test("unused deeply nested enqueues do not exhaust the queue analysis budget", async t => {
  const root = await mkdtemp(join(tmpdir(), "scale-queue-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const writes = "jobs.push(1);\n".repeat(1_500);
  const nested = "{\n".repeat(150) + writes + "}\n".repeat(150);
  await writeFile(join(root, "server.ts"), `
    import { createServer } from "node:http";
    const jobs: number[] = [];
    function work(job: number | undefined) { console.log(job); }
    createServer(() => jobs.push(1));
    setInterval(() => work(jobs.shift()), 100);
    function unused() { ${nested} }
  `);

  const findings = await detectQueueBackpressure(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "unbounded-request-queue");
  assert.match(findings[0].snippet, /createServer/);
});
