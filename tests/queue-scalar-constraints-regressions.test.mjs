import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";
import { AnalysisBudget } from "../dist/analysisBudget.js";
import { runAudit } from "../dist/runner.js";

const common = `import { createServer } from 'node:http';
  const jobs = []; let count = 0;
  function drain(job) { if (job !== undefined) count--; }
  setInterval(() => drain(jobs.shift()), 100);`;
async function withSource(source, run = detectQueueBackpressure) {
  const root = await mkdtemp(join(tmpdir(), "scale-scalar-constraints-"));
  try { await writeFile(join(root, "server.ts"), source); return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const route = (guard, body = "jobs.push(req.url); count++;") =>
  `createServer(req => { if (${guard}) return; ${body} });`;
const replaced = "globalThis.Boolean = () => false;";
const rejected = "if (Boolean(count >= 11)) return;";

for (const replacement of [false, true]) for (const [name, gate, body, expected] of [
  ["sequential double enqueue", "count === 11", "jobs.push(req.url); count++; jobs.push(req.url); count++;", 1],
  ["fixed callback batch", "count === 11", "[1, 2].forEach(item => { jobs.push(item); count++; });", 1],
  ["relational sequential bound", "count >= 11", "jobs.push(req.url); count++; jobs.push(req.url); count++;", 0],
  ["relational callback bound", "count >= 11", "[1, 2].forEach(item => { jobs.push(item); count++; });", 0],
  ["fractional equality", "count === 1.5", "jobs.push(req.url); count++;", 1],
  ["negative equality", "count === -1", "jobs.push(req.url); count++;", 1],
  ["unit equality", "count === 11", "jobs.push(req.url); count++;", 0],
  ["callback-local equality", "false", "[1, 2].forEach(item => { if (count === 11) return; jobs.push(item); count++; });", 0],
]) {
  test(`${name} uses the same precise admission with ${replacement ? "replaced" : "native"} Boolean`, async () => {
    const source = common + (replacement ? replaced : "") + route(gate, (replacement ? rejected : "") + body);
    assert.equal((await withSource(source)).length, expected);
  });
}

const wrappers = [
  n => `count === ${n}`,
  n => `(count === ${n}) === true`,
  n => `(count === ${n}) !== false`,
  n => `(count !== ${n}) === false`,
  n => `(count !== ${n}) !== true`,
  n => `count === ${n} ? true : false`,
  n => `count !== ${n} ? false : true`,
  n => `(count === ${n} ? true : false) === true`,
  n => `((count === ${n}) || 0) === true`,
  n => `((count !== ${n}) && 0) === false`,
  n => `true && (count === ${n})`,
  n => `req.aborted ? count === ${n} : count === ${n}`,
];
for (const replacement of [false, true]) for (const wrapper of wrappers) {
  for (const [caps, expected] of [[[10], 0], [[10, 10], 0], [[10, 11], 1]]) {
    test(`${wrapper(10)} keeps ${caps.join("/")} route limits with ${replacement ? "replaced" : "native"} Boolean`, async () => {
      const source = common + (replacement ? replaced : "") + caps.map(cap =>
        route(wrapper(cap), (replacement ? rejected : "") + "jobs.push(req.url); count++;")).join("\n");
      assert.equal((await withSource(source)).length, expected);
    });
  }
}

for (const guard of ["Boolean(count) === true", "Boolean(count) !== false", "!!count === true", "!!count !== false"]) {
  test(`${guard} retains its bounded route and correct warning location`, async () => {
    const bounded = route(guard, "jobs.push('bounded'); count++;");
    assert.deepEqual(await withSource(common + bounded), []);
    const findings = await withSource(common + bounded + route("false", "jobs.push('unbounded'); count++;"));
    assert.equal(findings.length, 1);
    assert.match(findings[0].snippet, /jobs\.push\('unbounded'\)/);
  });
}
for (const guard of ["available() === true", "(full() ? full() : full()) !== true", "(available() ? available() : available()) !== false"]) {
  test(`${guard} cannot admit its first job from an empty queue`, async () => {
    const helpers = "function full() { return count >= 10; } function available() { return count < 10; }";
    assert.deepEqual(await withSource(common + helpers + route(guard)), []);
    assert.equal((await withSource(common.replace("count = 0", "count = 10") + helpers + route(guard))).length, 1);
  });
}
for (const gate of ["(count === 10 && 1) === true", "(count === 10 ? 1 : false) === true", "count === true"]) {
  test(`truthiness cannot impersonate an exact Boolean result in ${gate}`, async () => {
    assert.equal((await withSource(common + route(gate))).length, 1);
  });
}
for (const gate of ["(count === 10 || 0) === true", "(count !== 10 && 0) === false", "(count === 10 ? 1 : false)"]) {
  test(`a mixed-value expression keeps its demonstrable scalar gate in ${gate}`, async () => {
    assert.deepEqual(await withSource(common + route(gate)), []);
  });
}

// Explore route/drain interleavings independently of the detector's interval
// algebra. These fixed, side-effect-free guards are test data, not audited code.
const policies = [
  "count === 3", "count === 4", "count !== 3", "count < 3", "count <= 3", "count > 3", "count >= 3",
  "count", "!count", "(count === 3) === true", "count === 3 ? true : false", "(count === 3 || 0) === true",
  "(count !== 3 && 0) === false", "count >= 2 && count <= 4", "count === 1 || count === 4", "count === 1.5",
];
function bounded(guards) {
  const predicates = guards.map(guard => new Function("count", `return !!(${guard});`));
  const pending = [0], seen = new Set(pending);
  const include = value => { if (!seen.has(value)) { seen.add(value); pending.push(value); } };
  while (pending.length) {
    const count = pending.pop();
    if (count > 0) include(count - 1);
    for (const predicate of predicates) if (!predicate(count)) {
      if (count >= 6) return false;
      include(count + 1);
    }
  }
  return true;
}
for (const first of policies) {
  test(`integer route-state oracle for ${first}`, async () => {
    for (const second of policies) for (const replacement of [false, true]) {
      const source = common + (replacement ? replaced : "") + [first, second].map(guard =>
        route(guard, (replacement ? rejected : "") + "jobs.push(req.url); count++;")).join("\n");
      assert.equal((await withSource(source)).length, bounded([first, second]) ? 0 : 1,
        `${first} / ${second} (${replacement ? "replaced" : "native"} Boolean)`);
    }
  });
}

function largeRoutes(size, { first = false, cap = 0, stale = false } = {}) {
  const guarded = Array.from({ length: size }, (_, index) =>
    route(`count`, `if (count === ${index + 10}) return; ${rejected} enqueue(req.url);`)).join("\n");
  const competing = stale ? `createServer(async req => { if (count === ${cap}) return; await load(); enqueue(req.url); });`
    : route(`count === ${cap}`, "enqueue(req.url);");
  return common + replaced + "function enqueue(job) { jobs.push(job); count++; }" +
    (first ? competing + guarded : guarded + competing);
}
async function measured(source) {
  const take = AnalysisBudget.prototype.take;
  let work = 0;
  AnalysisBudget.prototype.take = function(count = 1) {
    if (this.label === "Queue backpressure") work += count;
    return take.call(this, count);
  };
  try { return { work: () => work, findings: await withSource(source) }; }
  finally { AnalysisBudget.prototype.take = take; }
}
test("wide shared scalar formulas retain interval identity across route observations", async () => {
  const tree = (first, last) => last - first === 1 ? `count === ${first * 2 + 1}`
    : `(${tree(first, (first + last) >> 1)} || ${tree((first + last) >> 1, last)})`;
  const source = (width, routes) => common + `function full() { return ${tree(0, width)}; }
    function enqueue(job) { jobs.push(job); count++; }` +
    Array.from({ length: routes }, () => route("full()", "enqueue(req.url);")).join("\n");
  const one = await measured(source(256, 100)), two = await measured(source(512, 200));
  assert.deepEqual(one.findings, []); assert.deepEqual(two.findings, []);
  assert.ok(two.work() < one.work() * 2.3, `${one.work()} -> ${two.work()}`);
});
for (const first of [false, true]) {
  test(`240 guarded routes with the incompatible route ${first ? "first" : "last"} complete under unchanged limits`, async () => {
    const report = await withSource(largeRoutes(240, { first }), runAudit);
    assert.equal(report.complete, true);
    assert.ok(report.detectors.every(detector => detector.status === "complete"));
    assert.equal(report.findings.filter(finding => finding.id === "unbounded-request-queue").length, 1);
  });
  test(`doubling incompatible scalar paths stays near linear with the route ${first ? "first" : "last"}`, async () => {
    const one = await measured(largeRoutes(120, { first })), two = await measured(largeRoutes(240, { first }));
    assert.equal(one.findings.length, 1); assert.equal(two.findings.length, 1);
    assert.ok(two.work() < one.work() * 2.3, `${one.work()} -> ${two.work()}`);
  });
}
for (const first of [false, true]) for (const stale of [false, true]) {
  test(`shared path constraints retain ${stale ? "stale" : "fresh"} limits when analyzed ${first ? "first" : "last"}`, async () => {
    assert.equal((await withSource(largeRoutes(240, { first, stale, cap: 1000 }))).length, stale ? 1 : 0);
  });
}
