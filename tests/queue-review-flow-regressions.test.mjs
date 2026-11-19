import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AnalysisBudget } from "../dist/analysisBudget.js";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";
import { runAudit } from "../dist/runner.js";

const common = `import { createServer } from 'node:http';
  const jobs = []; let count = 0;
  function work(job) { if (job !== undefined) count--; }
  function full() { return count >= 10; }
  setInterval(() => work(jobs.shift()), 100);`;
const push = "jobs.push(req.url); count++;";
const route = (body, async = false) => `createServer(${async ? "async " : ""}req => { ${body} });`;

async function audit(source, run = detectQueueBackpressure) {
  const root = await mkdtemp(join(tmpdir(), "scale-queue-review-flow-"));
  const helper = /\benqueue\b/.test(source) ? "function enqueue(job) { jobs.push(job); count++; }" : "";
  try { await writeFile(join(root, "server.ts"), common + helper + source); return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

const nullishEqualities = [
  cap => `(count === ${cap}) ?? false`,
  cap => `((count === ${cap}) ?? false) === true`,
  cap => `((count !== ${cap}) ?? false) === false`,
  cap => `Boolean((count === ${cap}) ?? false)`,
  cap => `!!((count === ${cap}) ?? false)`,
];
for (const guard of nullishEqualities) {
  for (const [name, body, expected] of [
    ["one item", push, 0],
    ["two sequential items", `${push} ${push}`, 1],
    ["two helper invocations", "enqueue(req.url); enqueue(req.url);", 1],
    ["one native callback", "[req.url].forEach(enqueue);", 0],
    ["a repeated native callback", "[req.url, req.url].forEach(enqueue);", 1],
  ]) {
    test(`${guard(3)} preserves the scalar policy for ${name}`, async () => {
      assert.equal((await audit(route(`if (${guard(3)}) return; ${body}`))).length, expected);
    });
  }
  for (const [caps, expected] of [[[3, 3], 0], [[3, 4], 1]]) {
    test(`${guard(3)} retains the queue-wide ${caps.join("/")} route barrier`, async () => {
      const source = caps.map(cap => route(`if (${guard(cap)}) return; ${push}`)).join("\n");
      assert.equal((await audit(source)).length, expected);
    });
  }
  test(`${guard(3)} can be rechecked for every callback`, async () => {
    assert.deepEqual(await audit(route(`[1, 2].forEach(item => {
      if (${guard(3)}) return; jobs.push(item); count++;
    });`)), []);
  });
}

for (const body of [`${push} ${push}`, "[req.url, req.url].forEach(enqueue);"]) {
  test(`a nullish relational guard still bounds ${body}`, async () => {
    assert.deepEqual(await audit(route(`if ((count >= 3) ?? false) return; ${body}`)), []);
  });
}

const harmless = [
  "{}", "{ { {} } }", "{ console.log(req.url); }",
  "try { if (count >= 10) throw 0; } catch {}",
  "try { if (count >= 10) throw 0; } catch { console.log(req.url); } finally {}",
  "try { try { if (count >= 10) throw 0; } finally {} } catch {}",
  "{ try { if (count >= 10) throw 0; } catch {} }",
  "done: { if (count >= 10) break done; console.log(req.url); }",
  "switch (req.url) { case '/': console.log(req.url); break; default: break; }",
];
for (const prefix of harmless) for (const body of [push, "enqueue(req.url);", "[req.url].forEach(enqueue);"]) {
  test(`a normally completing prefix cannot guard ${body}: ${prefix}`, async () => {
    assert.equal((await audit(route(`${prefix} ${body}`))).length, 1);
  });
}
for (const prefix of [
  "{ if (count >= 10) return; }",
  "try { if (count >= 10) return; } catch {}",
  "try { if (count >= 10) throw 0; } catch { return; }",
  "try { if (count >= 10) throw 0; } catch (error) { throw error; }",
  "try { if (count >= 10) throw 0; } finally { console.log(req.url); }",
]) {
  test(`an escaping exit still guards admission: ${prefix}`, async () => {
    assert.deepEqual(await audit(route(`${prefix} ${push}`)), []);
  });
}
test("a harmless prefix cannot hide the open route beside a bounded route", async () => {
  const findings = await audit(route("if (count >= 10) return; jobs.push('bounded'); count++;")
    + route("{} jobs.push('unbounded'); count++;"));
  assert.equal(findings.length, 1);
  assert.match(findings[0].snippet, /jobs\.push\('unbounded'\)/);
});

const awaitedGuards = [
  ["(await Promise.resolve(false)) || count >= 10", 0],
  ["count >= 10 || (await Promise.resolve(false))", 1],
  ["Boolean((await Promise.resolve(false)) || count >= 10)", 0],
  ["Boolean(count >= 10 || (await Promise.resolve(false)))", 1],
  ["!((await Promise.resolve(true)) && count < 10)", 0],
  ["!(count < 10 && (await Promise.resolve(true)))", 1],
  ["(await Promise.resolve(false)) || full()", 0],
  ["full() || (await Promise.resolve(false))", 1],
  ["(await Promise.resolve(false)) || count >= 10 || (await Promise.resolve(false))", 1],
  ["count >= 10 || (await Promise.resolve(false)) || count >= 20", 0],
];
for (const [condition, expected] of awaitedGuards) for (const body of [push, "enqueue(req.url);", "[req.url, req.url].forEach(enqueue);"]) {
  test(`${condition} keeps evaluation order before ${body}`, async () => {
    assert.equal((await audit(route(`if (${condition}) return; ${body}`, true))).length, expected);
  });
}
for (const [condition, expected] of [
  ["(await Promise.resolve(true)) && count < 10", 0],
  ["count < 10 && (await Promise.resolve(true))", 1],
]) {
  test(`a selected branch requires a fresh count in ${condition}`, async () => {
    assert.equal((await audit(route(`if (${condition}) { ${push} }`, true))).length, expected);
  });
}
for (const [condition, expected] of [
  ["(await Promise.resolve(false)) || ((count === 3) ?? false)", 0],
  ["((count === 3) ?? false) || (await Promise.resolve(false))", 1],
  ["(await Promise.resolve(false)) || Boolean(count || 0) === true", 0],
  ["Boolean(count || 0) === true || (await Promise.resolve(false))", 1],
]) {
  test(`scalar admission after suspension respects ${condition}`, async () => {
    assert.equal((await audit(route(`if (${condition}) return; ${push}`, true))).length, expected);
  });
}
test("a snapshot captured before a condition's await remains stale afterward", async () => {
  for (const body of [push, "enqueue(req.url);"]) {
    assert.equal((await audit(route(`const observed = count;
      if ((await Promise.resolve(false)) || observed >= 10) return; ${body}`, true))).length, 1);
    assert.deepEqual(await audit(route(`await Promise.resolve(false); const observed = count;
      if (observed >= 10) return; ${body}`, true)), []);
  }
});
test("an ignored awaited Boolean argument invalidates the earlier counter value", async () => {
  for (const condition of [
    "Boolean(count >= 10, await Promise.resolve(false))",
    "Boolean.call(null, count >= 10, await Promise.resolve(false))",
    "Boolean.apply(null, [count >= 10, await Promise.resolve(false)])",
  ]) {
    assert.equal((await audit(route(`if (${condition}) return; ${push}`, true))).length, 1);
  }
});

const normalizedGuards = [
  "Boolean(count || 0) === true", "!!(count || 0) === true",
  "Boolean(0 || count) === true", "!!(0 || count) !== false",
  "Boolean(count ?? false) === true", "!!(count ?? false) !== false",
  "Boolean(count && true) === true", "!!(count && true) === true",
];
for (const condition of normalizedGuards) {
  test(`${condition} retains its finite truthiness barrier`, async () => {
    assert.deepEqual(await audit(route(`if (${condition}) return; ${push}`)), []);
    assert.deepEqual(await audit(route(`if (${condition}) return; [req.url].forEach(enqueue);`)), []);
    const findings = await audit(route(`if (${condition}) return; jobs.push('bounded'); count++;`)
      + route("jobs.push('unbounded'); count++;"));
    assert.equal(findings.length, 1);
    assert.match(findings[0].snippet, /jobs\.push\('unbounded'\)/);
  });
}
for (const condition of [
  "(count || 0) === true", "Boolean(count && 0) === true", "Boolean(count && req.ready) === true",
]) {
  test(`${condition} cannot impersonate normalized truthiness admission`, async () => {
    assert.equal((await audit(route(`if (${condition}) return; ${push}`))).length, 1);
  });
}
test("a replaced Boolean cannot establish normalized truthiness admission", async () => {
  assert.equal((await audit("globalThis.Boolean = () => false;"
    + route(`if (Boolean(count || 0) === true) return; ${push}`))).length, 1);
});

test("independent execution models distinguish skipped equality and stale observations", async () => {
  let skipped = 0;
  for (let request = 0; request < 1000; request++) {
    if ((skipped === 3) ?? false) continue;
    skipped += 2;
  }
  assert.equal(skipped, 2000);
  let fresh = 0, stale = 0;
  await Promise.all(Array.from({ length: 1000 }, async () => {
    if ((await Promise.resolve(false)) || fresh >= 10) return;
    fresh++;
  }));
  await Promise.all(Array.from({ length: 1000 }, async () => {
    if (stale >= 10 || (await Promise.resolve(false))) return;
    stale++;
  }));
  assert.equal(fresh, 10);
  assert.equal(stale, 1000);
  let normalized = 0;
  for (let request = 0; request < 1000; request++) {
    if (Boolean(normalized || 0) === true) continue;
    normalized++;
  }
  assert.equal(normalized, 1);
});

async function measured(source) {
  const take = AnalysisBudget.prototype.take;
  let work = 0;
  AnalysisBudget.prototype.take = function(count = 1) {
    if (this.label === "Queue backpressure") work += count;
    return take.call(this, count);
  };
  try { return { work: () => work, findings: await audit(source) }; }
  finally { AnalysisBudget.prototype.take = take; }
}
function awaitedScalarSelectors(size) {
  let condition = "await Promise.resolve(false)";
  for (let depth = 0; depth < size / 4; depth++) condition = `(${condition} ? count === 3 : count === 3)`;
  return route(`if (${condition}) return; ${push}`, true);
}
for (const [name, source, expected] of [
  ["neutral nested blocks", size => route("{".repeat(30)
    + "try { if (count >= 10) throw 0; } catch {}\n".repeat(size) + "}".repeat(30) + push), 1],
  ["normalized scalar routes", size => route("if (Boolean(count || 0) === true) return; enqueue(req.url);").repeat(size), 0],
  ["fresh awaited conditions", size => route("if ((await Promise.resolve(false)) || full()) return; enqueue(req.url);", true).repeat(size), 0],
  ["awaited scalar selectors", awaitedScalarSelectors, 0],
]) {
  test(`${name} grow within the existing work budget`, async () => {
    const one = await measured(source(80)), two = await measured(source(160));
    assert.equal(one.findings.length, expected);
    assert.equal(two.findings.length, expected);
    assert.ok(two.work() < one.work() * 3, `${one.work()} -> ${two.work()}`);
  });
}
test("the reviewed queue forms complete in the public audit", async () => {
  for (const [source, expected] of [
    [route(`{} ${push}`), 1],
    [route(`if ((count === 3) ?? false) return; ${push} ${push}`), 1],
    [route(`if ((await Promise.resolve(false)) || count >= 10) return; ${push}`, true), 0],
    [route(`if (Boolean(count || 0) === true) return; ${push}`), 0],
  ]) {
    const report = await audit(source, runAudit);
    assert.equal(report.complete, true);
    assert.equal(report.findings.filter(finding => finding.id === "unbounded-request-queue").length, expected);
    assert.equal(report.detectors.find(detector => detector.name === "detectQueueBackpressure")?.status, "complete");
  }
});
