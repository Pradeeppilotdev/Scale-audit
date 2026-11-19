import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";
import { detectSyncIo } from "../dist/detectors/syncIo.js";

async function audit(source, detector = detectQueueBackpressure) {
  const root = await mkdtemp(join(tmpdir(), "scale-constant-boolean-"));
  try {
    await writeFile(join(root, "server.ts"), source);
    return await detector(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function server(condition, before = "") {
  return `import { createServer } from 'node:http';
    const jobs = [];
    let count = 0;
    function full() { return count >= 10; }
    function enqueue(job) { jobs.push(job); count++; }
    function work(job) { if (job !== undefined) count--; }
    setInterval(() => work(jobs.shift()), 100);
    createServer(async req => {
      ${before}
      if (${condition}) return;
      enqueue(req.url);
    });`;
}

for (const condition of [
  "(true || full()) === false", "(false && full()) === true",
  "(true || full()) !== true", "(false && full()) !== false",
  "(1 || full()) === true", "('' && full()) === false",
  "((!full() || true) === true) === false", "(full() || true) === false",
]) {
  test(`the always-false strict comparison ${condition} cannot protect the queue`, async () => {
    assert.equal((await audit(server(condition))).length, 1);
  });
}

for (const condition of [
  "(true || full()) === true", "(false && full()) === false",
  "(1 || full()) !== true", "('' && full()) !== false", "(!full() || true) === true",
]) {
  test(`the always-true strict comparison ${condition} leaves no enqueue path`, async () => {
    assert.deepEqual(await audit(server(condition)), []);
  });
}

for (const [condition, expected] of [
  ["((await load()) || true) === false", 1],
  ["(!(await load()) || true) === false", 1],
  ["(true || (await load())) === false", 0],
  ["(false && (await load())) === true", 0],
]) {
  test(`folding ${condition} preserves exactly the evaluated awaits`, async () => {
    assert.equal((await audit(server(condition, "if (full()) return;"))).length, expected);
  });
}

for (const condition of ["(unknown() || true) === true", "(unknown() && false) === false"]) {
  test(`${condition} does not treat arbitrary truthy or falsy values as Booleans`, async () => {
    const findings = await audit(`import { createServer } from 'node:http';
      import { readFileSync } from 'node:fs';
      createServer(() => {
        if (${condition}) readFileSync('yes');
        else readFileSync('no');
      });`, detectSyncIo);
    assert.equal(findings.filter(finding => finding.severity === "high").length, 2);
  });
}

test("a folded strict comparison still evaluates its live I/O operand", async () => {
  const findings = await audit(`import { createServer } from 'node:http';
    import { readFileSync } from 'node:fs';
    createServer(() => {
      if ((readFileSync('evaluated') || true) === false) return;
      if ((true || readFileSync('skipped')) === false) return;
      readFileSync('after');
    });`, detectSyncIo);
  assert.deepEqual(findings.filter(finding => finding.severity === "high").map(finding => finding.line), [4, 6]);
});
