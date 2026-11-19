import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";

async function audit(body, { helpers = "", routes, async = false, initial = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "scale-scalar-admission-"));
  try {
    await writeFile(join(root, "server.ts"), `
      import { createServer } from 'node:http';
      const jobs = []; let count = ${initial};
      function full() { return count >= 10; }
      function drain(job) { if (job !== undefined) count--; }
      setInterval(() => drain(jobs.shift()), 10);
      globalThis.Boolean = () => false;
      ${helpers}
      ${routes ?? `createServer(${async ? "async " : ""}req => { ${body} });`}
    `);
    return await detectQueueBackpressure(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const rejected = "if (Boolean(full())) return;";
const scalar = "if (count === 11) return;";
const push = "jobs.push(req.url); count++;";
const enqueue = "function enqueue(job) { jobs.push(job); count++; }";

for (const condition of ["count", "!!count", "count === 11", "11 === count", "count == 11"]) {
  for (const first of [true, false]) {
    test(`an independent ${condition} gate ${first ? "before" : "after"} rejected Boolean stays effective`, async () => {
      const guard = `if (${condition}) return;`;
      assert.deepEqual(await audit(`${first ? `${guard} ${rejected}` : `${rejected} ${guard}`} ${push}`), []);
    });
  }
}

test("a rejected Boolean without an independent gate still reports", async () => {
  assert.equal((await audit(`${rejected} ${push}`)).length, 1);
});

test("a scalar gate can protect a unit enqueue helper", async () => {
  assert.deepEqual(await audit(`${scalar} ${rejected} enqueue(req.url);`, { helpers: enqueue }), []);
});

for (const count of [2, 100]) {
  test(`${count} separate unit request handlers retain their own scalar gates`, async () => {
    const routes = Array.from({ length: count }, () => `createServer(req => { ${scalar} ${rejected} ${push} });`).join("\n");
    assert.deepEqual(await audit("", { routes }), []);
  });
}

for (const [name, body, helpers] of [
  ["two direct pushes", `${push} ${push}`, ""],
  ["two calls to a unit helper", "enqueue(req.url); enqueue(req.url);", enqueue],
  ["one helper that enqueues twice", "enqueue(req.url);", "function enqueue(job) { jobs.push(job); count++; jobs.push(job); count++; }"],
  ["a repeated helper chain", "proxy(req.url);", `${enqueue} function proxy(job) { enqueue(job); enqueue(job); }`],
  ["a two-iteration loop", `for (let i = 0; i < 2; i++) { ${push} }`, ""],
]) {
  test(`an equality gate cannot certify ${name} that skips its limit`, async () => {
    assert.equal((await audit(`${scalar} ${rejected} ${body}`, { helpers })).length, 1);
  });
}

for (const [name, body, helpers] of [
  ["forEach", "[req.url, req.url].forEach(item => { jobs.push(item); count++; });", ""],
  ["map", "[req.url, req.url].map(item => { jobs.push(item); count++; });", ""],
  ["reduce", "[req.url, req.url].reduce((acc, item) => { jobs.push(item); count++; return acc; }, []);", ""],
  ["reduceRight", "[req.url, req.url].reduceRight((acc, item) => { jobs.push(item); count++; return acc; }, []);", ""],
  ["named callbacks", "[req.url, req.url].forEach(enqueue);", enqueue],
  ["Array.from mapping", "Array.from({ length: 2 }, () => { jobs.push(req.url); count++; });", ""],
  ["unknown-length callbacks", "Array.from({ length: Number(req.headers.n) }).forEach(item => { jobs.push(item); count++; });", ""],
]) {
  test(`bounded ${name} is not mistaken for a single callback`, async () => {
    assert.equal((await audit(`${scalar} ${rejected} ${body}`, { helpers })).length, 1);
  });
}

for (const [name, body, helpers] of [
  ["forEach", "[req.url].forEach(item => { jobs.push(item); count++; });", ""],
  ["map", "[req.url].map(item => { jobs.push(item); count++; });", ""],
  ["reduce", "[req.url].reduce((acc, item) => { jobs.push(item); count++; return acc; }, []);", ""],
  ["reduce without an initial accumulator", "[req.url, req.url].reduce((acc, item) => { jobs.push(item); count++; return acc; });", ""],
  ["named callback", "[req.url].forEach(enqueue);", enqueue],
  ["Array.from mapping", "Array.from({ length: 1 }, () => { jobs.push(req.url); count++; });", ""],
]) {
  test(`a genuinely single ${name} callback retains scalar admission`, async () => {
    assert.deepEqual(await audit(`${scalar} ${rejected} ${body}`, { helpers }), []);
  });
}

test("a fresh scalar check inside each callback protects repeated invocations", async () => {
  const body = `Array.from({ length: Number(req.headers.n) }).forEach(item => { ${scalar} ${rejected} jobs.push(item); count++; });`;
  assert.deepEqual(await audit(body), []);
});

test("a numeric bound remains effective for a bounded multi-item native batch", async () => {
  const body = `if (count >= 10) return; ${rejected} [req.url, req.url].forEach(item => { jobs.push(item); count++; });`;
  assert.deepEqual(await audit(body), []);
});

for (const helper of [false, true]) {
  test(`a fresh scalar gate after await protects ${helper ? "a unit helper" : "a direct enqueue"}`, async () => {
    const body = `await load(); ${scalar} ${rejected} ${helper ? "enqueue(req.url);" : push}`;
    assert.deepEqual(await audit(body, { async: true, helpers: helper ? enqueue : "" }), []);
  });

  test(`a scalar gate before await cannot protect ${helper ? "a later unit helper" : "a later direct enqueue"}`, async () => {
    const body = `${scalar} ${rejected} await load(); ${helper ? "enqueue(req.url);" : push}`;
    assert.equal((await audit(body, { async: true, helpers: helper ? enqueue : "" })).length, 1);
  });
}

test("a scalar limit already below the initial count cannot establish capacity", async () => {
  assert.equal((await audit(`${scalar} ${rejected} ${push}`, { initial: 12 })).length, 1);
});

test("an independent scalar check cannot protect an unrelated queue", async () => {
  const helpers = `const slow = []; let slowCount = 0;
    function drainSlow(job) { if (job !== undefined) slowCount--; }
    setInterval(() => drainSlow(slow.shift()), 20);`;
  const body = `${scalar} ${rejected} ${push} slow.push(req.url); slowCount++;`;
  const findings = await audit(body, { helpers });
  assert.equal(findings.length, 1);
  assert.match(findings[0].snippet, /slow\.push/);
});
