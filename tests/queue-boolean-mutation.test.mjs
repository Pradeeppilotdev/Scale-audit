import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";

async function audit(source) {
  const root = await mkdtemp(join(tmpdir(), "scale-queue-boolean-"));
  try {
    await writeFile(join(root, "server.ts"), source);
    return await detectQueueBackpressure(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const primaryQueue = `
  import { createServer } from "node:http";
  const jobs = [];
  let count = 0;
  function full() { return count >= 10; }
  function drain(job) { if (job !== undefined) count--; }
  setInterval(() => drain(jobs.shift()), 10);
`;
const secondaryQueue = `
  const slow = [];
  let slowCount = 0;
  function drainSlow(job) { if (job !== undefined) slowCount--; }
  setInterval(() => drainSlow(slow.shift()), 1000);
`;
const enqueue = `
    jobs.push(req.url);
    count++;
`;
const enqueueBoth = `
    jobs.push(req.url);
    count++;
    slow.push(req.url);
    slowCount++;
`;

for (const [name, replacement] of [
  ["unqualified assignment", "Boolean = () => false;"],
  ["direct property assignment", "globalThis.Boolean = () => false;"],
  ["host alias", "const host = globalThis; host.Boolean = () => false;"],
  ["computed host property", 'const key = "Boolean"; globalThis[key] = () => false;'],
  ["native property definition", 'Object.defineProperty(globalThis, "Boolean", { value: () => false });'],
  ["local shadow", "const Boolean = () => false;"],
]) {
  test(`a single counted queue still reports after Boolean ${name}`, async () => {
    const source = `${primaryQueue}
      ${replacement}
      createServer(req => {
        if (Boolean(full())) return;
        ${enqueue}
      });`;
    const findings = await audit(source);
    assert.equal(findings.length, 1);
    assert.match(findings[0].snippet, /jobs\.push/);
  });
}

test("replaced Boolean cannot protect a single enqueue helper", async () => {
  const source = `${primaryQueue}
    globalThis.Boolean = () => false;
    function enqueueJob(job) {
      jobs.push(job);
      count++;
    }
    createServer(req => {
      if (Boolean(full())) return;
      enqueueJob(req.url);
    });`;
  const findings = await audit(source);
  assert.equal(findings.length, 1);
  assert.match(findings[0].snippet, /jobs\.push/);
});

const guardedRoute = `
  createServer(() => {
    if (count) return;
    jobs.push("bounded");
    count++;
  });`;
const shadowedRoute = `
  createServer(() => {
    const Boolean = () => false;
    if (Boolean(full())) return;
    jobs.push("unbounded");
    count++;
  });`;

for (const [name, first, second] of [
  ["before", guardedRoute, shadowedRoute],
  ["after", shadowedRoute, guardedRoute],
]) {
  test(`a trusted guard ${name} a shadowed Boolean cannot mask the other route`, async () => {
    const findings = await audit(primaryQueue + first + second);
    assert.equal(findings.length, 1);
    assert.match(findings[0].snippet, /jobs\.push\("unbounded"\)/);
  });
}

for (const [name, replacement, expected] of [
  ["native Boolean", "", 1],
  ["replaced Boolean", "globalThis.Boolean = () => false;", 2],
]) {
  test(`${name} preserves independent admission for two queues`, async () => {
    const source = `${primaryQueue}${secondaryQueue}
      ${replacement}
      createServer(req => {
        if (Boolean(full())) return;
        ${enqueueBoth}
      });`;
    const findings = await audit(source);
    assert.equal(findings.length, expected);
    assert.ok(findings.some(finding => /slow\.push/.test(finding.snippet)));
    assert.equal(findings.some(finding => /jobs\.push/.test(finding.snippet)), expected === 2);
  });
}

for (const [name, condition] of [
  ["native Boolean", "Boolean(full())"],
  ["ordinary comparison", "count >= 10"],
  ["scalar equality", "count === 10"],
]) {
  test(`${name} still guards a single counted queue`, async () => {
    const source = `${primaryQueue}
      createServer(req => {
        if (${condition}) return;
        ${enqueue}
      });`;
    assert.deepEqual(await audit(source), []);
  });
}

test("opaque application admission does not establish a visible queue bound", async () => {
  const source = `${primaryQueue} createServer(req => { if (!admitJob(req)) return; ${enqueue} });`;
  assert.equal((await audit(source)).length, 1);
});

test("an independent capacity check remains valid after a replaced Boolean", async () => {
  const source = `${primaryQueue}
    globalThis.Boolean = () => false;
    createServer(req => {
      if (Boolean(full())) return;
      if (count >= 10) return;
      ${enqueue}
    });`;
  assert.deepEqual(await audit(source), []);
});

test("an await still invalidates a native Boolean capacity check", async () => {
  const source = `${primaryQueue}
    createServer(async req => {
      if (Boolean(full())) return;
      await load();
      ${enqueue}
    });`;
  assert.equal((await audit(source)).length, 1);
});
