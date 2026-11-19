import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";
import { runAudit } from "../dist/runner.js";

async function withRoutes(routes, run = detectQueueBackpressure, { helper = false, setup = "", rejected = true, initial = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "scale-queue-route-limits-"));
  try {
    const push = helper ? "enqueue(req.url);" : "jobs.push(req.url); count++;";
    const body = routes.map(route => route.replaceAll("PUSH", push).replaceAll("REJECTED", rejected ? "if (Boolean(full())) return;" : "")).join("\n");
    await writeFile(join(root, "server.ts"), `import { createServer } from 'node:http';
      const jobs = []; let count = ${initial};
      function full() { return count >= 10; }
      function drain(job) { if (job !== undefined) count--; }
      setInterval(() => drain(jobs.shift()), 100);
      ${rejected ? "globalThis.Boolean = () => false;" : ""}
      ${helper ? "function enqueue(job) { jobs.push(job); count++; }" : ""}
      ${setup}
      ${body}`);
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const route = gate => `createServer(req => { if (${gate}) return; REJECTED PUSH });`;

for (const helper of [false, true]) for (const reverse of [false, true]) {
  for (const [first, second, expected] of [
    ["count === 10", "count === 11", 1],
    ["count >= 20", "count === 11", 1],
    ["count >= 5", "count === 11", 0],
    ["count > 10", "count === 11", 0],
    ["full()", "count === 11", 0],
  ]) {
    test(`${helper ? "helper" : "direct"} routes ${first} / ${second} keep a common barrier in ${reverse ? "reverse" : "forward"} order`, async () => {
      const routes = [route(first), route(second)];
      if (reverse) routes.reverse();
      assert.equal((await withRoutes(routes, detectQueueBackpressure, { helper })).length, expected);
    });
  }
}

for (const helper of [false, true]) {
  test(`different ${helper ? "helper" : "direct"} equality limits cannot fall back to generic admission`, async () => {
    assert.equal((await withRoutes([route("count === 10"), route("count === 11")], detectQueueBackpressure,
      { helper, rejected: false })).length, 1);
  });

  test(`negated ${helper ? "helper" : "direct"} branch gates retain their queue-wide threshold`, async () => {
    const branches = [10, 11].map(cap => `createServer(req => { if (count !== ${cap}) { REJECTED PUSH } });`);
    assert.equal((await withRoutes(branches, detectQueueBackpressure, { helper })).length, 1);
    assert.deepEqual(await withRoutes([branches[0], branches[0]], detectQueueBackpressure, { helper }), []);
  });

  test(`fresh and stale ${helper ? "helper" : "direct"} competing gates remain distinct after await`, async () => {
    const fresh = "createServer(async req => { await load(); if (count === 10) return; REJECTED PUSH });";
    const stale = "createServer(async req => { if (count === 10) return; REJECTED await load(); PUSH });";
    assert.deepEqual(await withRoutes([route("count === 10"), fresh], detectQueueBackpressure, { helper }), []);
    assert.equal((await withRoutes([route("count === 10"), stale], detectQueueBackpressure, { helper })).length, 1);
  });
}

test("a gate inside every unknown-length callback can share another route's barrier", async () => {
  const callback = cap => `createServer(req => {
    Array.from({ length: Number(req.headers.n) }).forEach(item => {
      if (count === ${cap}) return; REJECTED jobs.push(item); count++;
    });
  });`;
  assert.deepEqual(await withRoutes([route("count === 10"), callback(10)]), []);
  assert.equal((await withRoutes([route("count === 10"), callback(11)])).length, 1);
});

test("an outer gate cannot let a competing batch skip the common barrier", async () => {
  for (const collection of ["[req.url, req.url]", "Array.from({ length: Number(req.headers.n) })"]) {
    const batch = `createServer(req => {
      if (count === 11) return; REJECTED
      ${collection}.forEach(item => { jobs.push(item); count++; });
    });`;
    assert.equal((await withRoutes([route("count === 11"), batch])).length, 1);
  }
});

test("captured numeric aliases preserve threshold identity across routes", async () => {
  const options = { setup: "const LIMIT = 10; const SAME = LIMIT; const OTHER = 11;" };
  assert.deepEqual(await withRoutes([route("count === LIMIT"), route("count === SAME")], detectQueueBackpressure, options), []);
  assert.equal((await withRoutes([route("count === LIMIT"), route("count === OTHER")], detectQueueBackpressure, options)).length, 1);
});

test("100 handlers sharing one unit helper complete with the same queue barrier", async () => {
  const routes = Array.from({ length: 100 }, () => route("count === 10"));
  const report = await withRoutes(routes, runAudit, { helper: true });
  assert.equal(report.complete, true);
  assert.ok(report.detectors.every(detector => detector.status === "complete"));
  assert.equal(report.findings.filter(finding => finding.id === "unbounded-request-queue").length, 0);
  assert.equal((await withRoutes([...routes, "createServer(req => { PUSH });"], detectQueueBackpressure, { helper: true })).length, 1);
});

test("an initial count at one route's limit does not protect a different limit", async () => {
  assert.equal((await withRoutes([route("count === 10"), route("count === 11")], detectQueueBackpressure,
    { initial: 10 })).length, 1);
});

for (const gates of [
  "if (count) return;",
  "if (count === 10) return; if (count) return;",
  "if (count) return; if (count === 10) return;",
]) {
  for (const reverse of [false, true]) {
    test(`an open route preserves truthiness provenance for ${gates} in ${reverse ? "reverse" : "forward"} route order`, async () => {
      const routes = [
        `createServer(req => { ${gates} REJECTED jobs.push('bounded'); count++; });`,
        "createServer(req => { jobs.push('unbounded'); count++; });",
      ];
      if (reverse) routes.reverse();
      const findings = await withRoutes(routes);
      assert.equal(findings.length, 1);
      assert.match(findings[0].snippet.split("\n")[1], /jobs\.push\('unbounded'\)/);
    });
  }
}

for (const [gate, expected] of [
  ["count >= 5 || req.aborted", 0],
  ["req.aborted || count >= 5", 0],
  ["count >= 5 && req.aborted", 1],
  ["req.aborted && count >= 5", 1],
  ["!(count < 5 && !req.aborted)", 0],
  ["!(count < 5 || !req.aborted)", 1],
  ["count >= 5 && count <= 20", 0],
  ["count >= 5 && count <= 10", 1],
  ["count >= 5 || count === 30", 0],
  ["count >= 20 || count === 30", 1],
  ["true && count >= 5", 0],
  ["false || count >= 5", 0],
]) {
  test(`a compound competing gate ${gate} preserves its counter guarantee`, async () => {
    assert.equal((await withRoutes([route("count === 11"), route(gate)])).length, expected);
  });
}

for (const [gate, expected] of [["count < 5 && !req.aborted", 0], ["count < 5 || !req.aborted", 1]]) {
  test(`an admitting compound branch ${gate} uses the opposite truth outcome`, async () => {
    const branch = `createServer(req => { if (${gate}) { REJECTED PUSH } });`;
    assert.equal((await withRoutes([route("count === 11"), branch], detectQueueBackpressure, { helper: true })).length, expected);
  });
}

test("a stable compound helper retains its barrier through negation", async () => {
  const setup = "function available() { return count < 5 && !process.env.STOP; }";
  assert.deepEqual(await withRoutes([route("count === 11"), route("!available()")], detectQueueBackpressure, { setup, helper: true }), []);
});

for (const helper of [false, true]) {
  for (const [first, second, expected] of [[10, 10, 0], [10, 11, 1]]) {
    test(`trusted scalar guard helpers ${first}/${second} keep a queue-wide barrier with ${helper ? "helper" : "direct"} producers`, async () => {
      const setup = `function first() { return count === ${first}; } const second = () => count === ${second};`;
      assert.equal((await withRoutes([route("first()"), route("second()")], detectQueueBackpressure,
        { helper, setup, rejected: false })).length, expected);
    });
    test(`native Boolean-wrapped scalar gates ${first}/${second} keep a queue-wide barrier with ${helper ? "helper" : "direct"} producers`, async () => {
      assert.equal((await withRoutes([route(`Boolean(count === ${first})`), route(`Boolean(count === ${second})`)],
        detectQueueBackpressure, { helper, rejected: false })).length, expected);
    });
  }
}
