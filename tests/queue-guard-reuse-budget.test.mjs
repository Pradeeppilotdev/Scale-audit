import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AnalysisBudget } from "../dist/analysisBudget.js";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";
import { runAudit } from "../dist/runner.js";

async function withSource(source, run) {
  const root = await mkdtemp(join(tmpdir(), "scale-guard-reuse-"));
  try {
    await writeFile(join(root, "server.ts"), source);
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function predicate(first, last, limit = "10") {
  if (last - first === 1) return `count${first} >= ${limit}`;
  const middle = (first + last) >>> 1;
  return `(${predicate(first, middle, limit)} || ${predicate(middle, last, limit)})`;
}

function common(width, { limit = "10", before = "", after = "", counter = width - 1, producer = true } = {}) {
  return `const jobs = [];
    ${Array.from({ length: width }, (_, index) => `let count${index} = 0;`).join("\n")}
    function work(job) { if (job !== undefined) count${counter}--; }
    setInterval(() => work(jobs.shift()), 100);
    ${before}
    function full() { return ${predicate(0, width, limit)}; }
    ${after}
    ${producer ? `function enqueue(job) { jobs.push(job); count${counter}++; }` : ""}
  `;
}

function direct(repeats, tail = "") {
  return `import { createServer } from 'node:http';
    ${common(350, { producer: false })}
    createServer(async req => {
      ${"if (full() === true) return; jobs.push(req.url); count349++;\n".repeat(repeats)}
      ${tail}
    });`;
}

function routes(repeats, options = {}, tail = "") {
  return `import express from 'express'; const app = express();
    ${common(options.width ?? 100, options)}
    ${Array.from({ length: repeats }, (_, index) =>
      `app.get('/route${index}', req => { if (full() === true) return; enqueue(req.url); });`).join("\n")}
    ${tail}`;
}

function scalarRoutes(repeats, { open, truthy = true, tail = "" } = {}) {
  const unguarded = "createServer(req => enqueue(req.url));";
  return `import { createServer } from 'node:http';
    ${common(1)}
    globalThis.Boolean = () => false;
    ${open === "before" ? unguarded : ""}
    ${Array.from({ length: repeats }, (_, index) => `createServer(req => {
      ${truthy ? "if (count0) return;" : ""}
      if (count0 === ${index + 10}) return;
      if (Boolean(full())) return;
      enqueue(req.url);
    });`).join("\n")}
    ${open === "after" ? unguarded : ""}
    ${tail}`;
}

async function measured(source) {
  return withSource(source, async root => {
    const take = AnalysisBudget.prototype.take;
    let work = 0;
    AnalysisBudget.prototype.take = function(count = 1) {
      if (this.label === "Queue backpressure") work += count;
      return take.call(this, count);
    };
    try {
      return { findings: await detectQueueBackpressure(root), work };
    } finally {
      AnalysisBudget.prototype.take = take;
    }
  });
}

for (const [name, source] of [
  ["271 direct enqueues with 350 shared capacity facts", direct(271)],
  ["100 routes sharing a 100-counter predicate", routes(100)],
  ["100 routes whose shared helper precedes its initialized limit", routes(100, { limit: "LIMIT", after: "const LIMIT = 10;" })],
  ["160 routes sharing 150 facts with one relevant queue counter", routes(160, { width: 150 })],
]) {
  test(`${name} completes the whole audit within the unchanged work budget`, async () => {
    const report = await withSource(source, runAudit);
    assert.equal(report.complete, true);
    assert.equal(report.coverage.analyzed, 1);
    assert.equal(report.coverage.skipped.length, 0);
    assert.ok(report.detectors.every(detector => detector.status === "complete"));
    assert.deepEqual(report.findings.filter(finding => finding.id === "unbounded-request-queue"), []);
  });
}

test("doubling direct enqueues reuses admission facts instead of scanning every bound again", async () => {
  const first = await measured(direct(271));
  const doubled = await measured(direct(542));
  assert.deepEqual(first.findings, []);
  assert.deepEqual(doubled.findings, []);
  assert.ok(doubled.work < first.work * 2.5, `${first.work} -> ${doubled.work}`);
});

test("equivalent scalar compounds preserve wide admission segments as callers double", async () => {
  const labels = Array.from({ length: 220 }, (_, index) => index);
  const source = repeats => `import { createServer } from 'node:http';
    ${labels.map(index => `const q${index} = []; let count${index} = 0;`).join("\n")}
    function work(job) {}
    function produce() { ${labels.map(index => `q${index}.push(1); count${index}++;`).join("\n")} }
    ${labels.map(index => `setInterval(() => work(q${index}.shift()), 100);`).join("\n")}
    function full() { return ${predicate(0, labels.length)}; }
    createServer(req => { ${"if (full() || count0 === 11) return; produce();\n".repeat(repeats)} });`;
  const first = await measured(source(350));
  const doubled = await measured(source(700));
  assert.deepEqual(first.findings, []);
  assert.deepEqual(doubled.findings, []);
  assert.ok(doubled.work < first.work * 2.5, `${first.work} -> ${doubled.work}`);
});

for (const fresh of [false, true]) {
  test(`equivalent scalar compounds retain ${fresh ? "fresh" : "stale"} observations after await`, async () => {
    const source = `import { createServer } from 'node:http';
      ${common(1)}
      createServer(async req => {
        if (full() || count0 === 11) return;
        enqueue(req.url);
        await load();
        ${fresh ? "if (full() || count0 === 11) return;" : ""}
        enqueue(req.url);
      });`;
    assert.equal((await withSource(source, detectQueueBackpressure)).length, fresh ? 0 : 1);
  });
}

test("doubling routes reuses the shared predicate while charging their admission checks", async () => {
  const first = await measured(routes(100));
  const doubled = await measured(routes(200));
  assert.deepEqual(first.findings, []);
  assert.deepEqual(doubled.findings, []);
  assert.ok(doubled.work < first.work * 2.5, `${first.work} -> ${doubled.work}`);
});

for (const late of [false, true]) {
  test(`doubling both guard width and routes reuses ${late ? "later initialized" : "literal"} capacity facts`, async () => {
    const options = late ? { limit: "CAP", after: "const LIMIT = 10; const CAP = LIMIT;" } : {};
    const first = await measured(routes(100, { ...options, width: 100 }));
    const doubled = await measured(routes(200, { ...options, width: 200 }));
    assert.deepEqual(first.findings, []);
    assert.deepEqual(doubled.findings, []);
    assert.ok(doubled.work < first.work * 2.5, `${first.work} -> ${doubled.work}`);
  });
}

test("repeated guards before their captured limit share the unavailable proof", async () => {
  const source = routes(100, { limit: "LIMIT" }, "const LIMIT = 10;");
  const report = await withSource(source, runAudit);
  assert.equal(report.complete, true);
  assert.ok(report.detectors.every(detector => detector.status === "complete"));
  assert.equal(report.findings.filter(finding => finding.id === "unbounded-request-queue").length, 1);
});

for (const open of ["before", "after"]) {
  test(`an open route ${open} scalar-gated callers rejects every candidate without repeated graph work`, async () => {
    const first = await measured(scalarRoutes(100, { open }));
    const doubled = await measured(scalarRoutes(200, { open }));
    assert.equal(first.findings.length, 1);
    assert.equal(doubled.findings.length, 1);
    assert.ok(doubled.work < first.work * 2.5, `${first.work} -> ${doubled.work}`);
  });
}

test("200 scalar-gated callers plus one last open route complete the whole audit", async () => {
  const report = await withSource(scalarRoutes(200, { open: "after" }), runAudit);
  assert.equal(report.complete, true);
  assert.ok(report.detectors.every(detector => detector.status === "complete"));
  assert.equal(report.findings.filter(finding => finding.id === "unbounded-request-queue").length, 1);
});

test("the optimistic path precheck still requires a common bound", async () => {
  assert.deepEqual(await withSource(scalarRoutes(200), detectQueueBackpressure), []);
  const first = await measured(scalarRoutes(100, { truthy: false }));
  const doubled = await measured(scalarRoutes(200, { truthy: false }));
  assert.equal(first.findings.length, 1);
  assert.equal(doubled.findings.length, 1);
  assert.ok(doubled.work < first.work * 2.5, `${first.work} -> ${doubled.work}`);
});

for (const fresh of [false, true]) {
  test(`the shared scalar path precheck preserves ${fresh ? "fresh" : "stale"} admission around await`, async () => {
    const tail = `createServer(async req => {
      ${fresh ? "await load(); if (count0) return;" : "if (count0) return; await load();"}
      enqueue(req.url);
    });`;
    const findings = await withSource(scalarRoutes(100, { tail }), detectQueueBackpressure);
    assert.equal(findings.length, fresh ? 0 : 1);
  });
}

test("doubling copies of a wide host patch reuses its source membership and tracked keys", async () => {
  const properties = Array.from({ length: 350 }, (_, index) => `extra${index}: ${index}`).join(",");
  const source = copies => `import { createServer } from 'node:http';
    const patch = { Boolean: () => false, ${properties} };
    Object.assign(globalThis, ${Array(copies).fill("patch").join(",")});
    ${common(1)}
    createServer(req => { if (Boolean(full())) return; enqueue(req.url); });`;
  const first = await measured(source(700));
  const doubled = await measured(source(1400));
  assert.equal(first.findings.length, 1);
  assert.equal(doubled.findings.length, 1);
  assert.ok(doubled.work < first.work * 2.5, `${first.work} -> ${doubled.work}`);
});

test("an earlier initialized constant limit and alias can share their predicate across routes", async () => {
  const source = routes(100, { before: "const LIMIT = 10; const CAP = LIMIT;", limit: "CAP" });
  assert.deepEqual(await withSource(source, detectQueueBackpressure), []);
});

test("a later await cannot reuse an earlier direct-enqueue capacity segment", async () => {
  const source = direct(271, "await load(); jobs.push(req.url); count349++;");
  assert.equal((await withSource(source, detectQueueBackpressure)).length, 1);
});

test("a helper's captured counter snapshot cannot become fresh through shared proof reuse", async () => {
  const source = `import { createServer } from 'node:http';
    ${common(1)}
    createServer(async req => {
      const observed = count0;
      function captured() { return observed >= 10; }
      if (captured() === true) return;
      await load();
      if (captured() === true) return;
      enqueue(req.url);
    });`;
  assert.equal((await withSource(source, detectQueueBackpressure)).length, 1);
});

for (const tail of [
  "app.get('/open', req => enqueue(req.url));",
  "app.get('/resumed', async req => { if (full() === true) return; await load(); enqueue(req.url); });",
]) {
  test(`shared safe routes do not hide ${tail}`, async () => {
    assert.equal((await withSource(routes(100, {}, tail), detectQueueBackpressure)).length, 1);
  });
  test(`later initialized shared limits do not hide ${tail}`, async () => {
    const options = { limit: "CAP", after: "const LIMIT = 10; const CAP = LIMIT;" };
    assert.equal((await withSource(routes(100, options, tail), detectQueueBackpressure)).length, 1);
  });
}

for (const order of [["early", "middle", "late"], ["late", "middle", "early"], ["middle", "early", "late"]]) {
  test(`helper availability keeps all initialization intervals in ${order.join("/")} cache order`, async () => {
    const source = `import { createServer } from 'node:http';
      const ${order.map(name => `${name} = []`).join(", ")};
      let earlyCount = 0, middleCount = 0, lateCount = 0;
      ${["early", "middle", "late"].map(name => `
        function enqueue_${name}(job) { ${name}.push(job); ${name}Count++; }
        function drain_${name}(job) { if (job !== undefined) ${name}Count--; }
        setInterval(() => drain_${name}(${name}.shift()), 10);
      `).join("\n")}
      function full() { return earlyCount >= FIRST || middleCount >= SECOND || lateCount >= SECOND; }
      function wrapped() { return full(); }
      createServer(req => { if (wrapped() === true) return; enqueue_early(req.url); });
      const FIRST = 10;
      createServer(req => { if (wrapped() === true) return; enqueue_middle(req.url); });
      const SECOND = 10;
      createServer(req => { if (wrapped() === true) return; enqueue_late(req.url); });`;
    const findings = await withSource(source, detectQueueBackpressure);
    assert.deepEqual(findings.map(finding => finding.snippet.split("\n")[1].match(/\b(early|middle|late)\.push/)?.[1]).sort(),
      ["early", "middle"]);
  });
}

for (const declarations of ["const early = [], late = [];", "const late = [], early = [];"]) {
  test(`captured limits retain registration context with ${declarations}`, async () => {
    const source = `import { createServer } from 'node:http';
      ${declarations}
      let earlyCount = 0, lateCount = 0;
      function enqueueEarly(job) { early.push(job); earlyCount++; }
      function enqueueLate(job) { late.push(job); lateCount++; }
      function drainEarly(job) { if (job !== undefined) earlyCount--; }
      function drainLate(job) { if (job !== undefined) lateCount--; }
      setInterval(() => drainEarly(early.shift()), 100);
      setInterval(() => drainLate(late.shift()), 100);
      function full() { return earlyCount >= LIMIT || lateCount >= LIMIT; }
      function wrapped() { return full(); }
      createServer(req => { if (wrapped() === true) return; enqueueEarly(req.url); });
      const LIMIT = 10;
      createServer(req => { if (wrapped() === true) return; enqueueLate(req.url); });`;
    const findings = await withSource(source, detectQueueBackpressure);
    assert.equal(findings.length, 1);
    assert.match(findings[0].snippet.split("\n")[1], /early\.push/);
  });
}
