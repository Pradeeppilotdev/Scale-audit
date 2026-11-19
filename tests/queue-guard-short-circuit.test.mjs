import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";
import { detectSyncIo } from "../dist/detectors/syncIo.js";

async function audit(source, detect = detectQueueBackpressure) {
  const root = await mkdtemp(join(tmpdir(), "scale-queue-short-circuit-"));
  try {
    await writeFile(join(root, "server.ts"), source);
    return await detect(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const http = "import { createServer } from 'node:http';";
const queues = `
  ${http}
  const fast = [], slow = [];
  let fastCount = 0, slowCount = 0;
  function enqueue(job) {
    fast.push(job);
    fastCount++;
    slow.push(job);
    slowCount++;
  }
  function drainFast(job) { if (job !== undefined) fastCount--; }
  function drainSlow(job) { if (job !== undefined) slowCount--; }
  setInterval(() => drainFast(fast.shift()), 10);
  setInterval(() => drainSlow(slow.shift()), 1000);
  function full() { return fastCount >= 10; }
  function available() { return fastCount < 10; }
`;
const batch = "const size = Math.min(10, Number(req.url.slice(1))); Array.from({ length: size }, (_, i) => enqueue(i));";

for (const condition of [
  "full() && true", "true && full()", "full() || false", "false || full()",
  "!(available() && true)", "!(true && available())", "!(available() || false)", "!(false || available())",
  "(full() && true) === true", "(full() || false) === true",
]) {
  test(`${condition} preserves the capacity guard for only its own queue`, async () => {
    const findings = await audit(`${queues} createServer(req => { if (${condition}) return; ${batch} });`);
    assert.equal(findings.length, 1);
    assert.match(findings[0].snippet, /slow\.push/);
  });
}

for (const condition of ["full() && false", "false && full()", "!(full() || true)", "!(true || full())"]) {
  test(`${condition} cannot hide an unconditional enqueue`, async () => {
    const source = `${queues} createServer(req => { if (${condition}) return; enqueue(req.url); });`;
    assert.equal((await audit(source)).length, 2);
  });
}

for (const condition of ["full() || true", "true || full()", "!(full() && false)", "!(false && full())"]) {
  test(`${condition} leaves no path to the later batch`, async () => {
    assert.deepEqual(await audit(`${queues} createServer(req => { if (${condition}) return; ${batch} });`), []);
  });
}

for (const [condition, expected] of [["(await load()) && false", 2], ["false && (await load())", 1]]) {
  test(`${condition} invalidates earlier capacity only if its await is evaluated`, async () => {
    const source = `${queues} createServer(async req => {
      if (full()) return;
      if (${condition}) return;
      ${batch}
    });`;
    const findings = await audit(source);
    assert.equal(findings.length, expected);
    assert.ok(findings.some(finding => /slow\.push/.test(finding.snippet)));
  });
}

test("a known short-circuit result still evaluates its reachable I/O operand", async () => {
  const findings = await audit(`${http}
    import { readFileSync } from 'node:fs';
    createServer(() => {
      if (true || readFileSync('skipped')) {
        if (readFileSync('evaluated') || true) return;
      }
      readFileSync('unreachable');
    });`, detectSyncIo);
  assert.deepEqual(findings.filter(finding => finding.severity === "high").map(finding => finding.line), [5]);
});
