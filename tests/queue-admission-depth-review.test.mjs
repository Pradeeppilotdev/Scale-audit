import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AnalysisBudget } from "../dist/analysisBudget.js";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";
import { runAudit } from "../dist/runner.js";

const push = "jobs.push(req.url)";
const route = body => `createServer(async (req, res) => { ${body} });`;
async function audit(routes, { setup = "", sibling = "", run = detectQueueBackpressure } = {}) {
  const root = await mkdtemp(join(tmpdir(), "scale-queue-depth-"));
  try {
    await writeFile(join(root, "api.ts"), `import { createServer } from 'node:http';
      const jobs = []; let count = 0;
      function work(job) { if (job !== undefined) count--; }
      setInterval(() => work(jobs.shift()), 100);
      ${setup}
      ${routes}`);
    if (sibling) await writeFile(join(root, "sibling.ts"), sibling);
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const [name, body, expected] of [
  ["response header", `res.setHeader('X-Queue-Depth', jobs.length); ${push};`, 1],
  ["computed length read", `record(jobs['length']); ${push};`, 1],
  ["full length guard", `if (jobs.length >= 10) return; ${push};`, 0],
  ["computed length guard", `if (jobs['length'] >= 10) return; ${push};`, 0],
  ["current depth snapshot", `const n = jobs.length; if (n >= 10) return; ${push};`, 0],
  ["stale depth snapshot", `const n = jobs.length; await load(); if (n >= 10) return; ${push};`, 1],
  ["current short-circuit depth snapshot", `const n = jobs.length; n < 10 && ${push};`, 0],
  ["reversed short-circuit depth snapshot", `const n = jobs.length; 10 > n && ${push};`, 0],
  ["stale short-circuit depth snapshot", `const n = jobs.length; await load(); n < 10 && ${push};`, 1],
  ["effect before the inline snapshot guard", `const n = jobs.length; (reserve(), n < 10) && ${push};`, 1],
  ["length guard applies only to one path", `if (req.url === '/guarded' && jobs.length >= 10) return; ${push};`, 1],
  ["length guard is stale after suspension", `if (jobs.length >= 10) return; await load(); ${push};`, 1],
  ["fresh length guard after suspension", `await load(); if (jobs.length >= 10) return; ${push};`, 0],
  ["length assignment can truncate the queue", `${push}; jobs.length = 0;`, 0],
  ["destructuring write to depth", `${push}; [jobs['length']] = [0];`, 0],
  ["logical admission", `req.url && ${push};`, 1],
  ["statically executed", `true && ${push};`, 1],
  ["statically skipped", `false && ${push};`, 0],
  ["unbounded disjunction", `req.aborted || ${push};`, 1],
  ["unbounded nullish fallback", `req.job ?? ${push};`, 1],
  ["skipped nullish fallback", `0 ?? ${push};`, 0],
  ["comma expression", `(req.url, ${push});`, 1],
  ["property result", `${push}.toString();`, 1],
  ["computed property key", `req.headers[${push}];`, 1],
  ["object literal property", `res.end({depth: ${push}});`, 1],
  ["optional argument skipped", `(null)?.(${push});`, 0],
  ["optional receiver evaluated", `${push}?.toString();`, 1],
  ["logical bound", `jobs.length < 10 && ${push};`, 0],
  ["disjunctive bound", `jobs.length >= 10 || ${push};`, 0],
  ["unrelated logical guard", `jobs.length >= 0 && ${push};`, 1],
  ["ternary admitted branch", `jobs.length >= 10 ? res.end() : ${push};`, 0],
  ["ternary open branch", `req.url ? res.end() : ${push};`, 1],
  ["other ternary branch suspends", `if (jobs.length >= 10) return; req.aborted ? await load() : ${push};`, 0],
  ["same ternary branch suspends", `if (jobs.length >= 10) return; req.aborted ? 0 : (await load(), ${push});`, 1],
  ["pre-push reservation", `if (count >= 10) return; ++count; ${push};`, 0],
  ["post-push reservation", `if (count >= 10) return; ${push}; count++;`, 0],
  ["one reservation cannot cover two pushes", `if (count >= 10) return; ${push}; ++count; ${push};`, 1],
  ["adjacent pre-push reservations", `if (count >= 10) return; ++count; ${push}; ++count; ${push};`, 0],
  ["conditional increment does not reserve capacity", `if (count >= 10) return; if (req.url) ++count; ${push};`, 1],
  ["counter drift invalidates reservations", `if (count >= 10) return; ++count; ${push}; count--;`, 1],
]) {
  test(`private queue admission with ${name}`, async () => {
    assert.equal((await audit(route(body))).length, expected);
  });
}

for (const [first, second, expected] of [
  ["jobs.length < 10", "true", 1],
  ["jobs.length < 10", "jobs.length < 10", 0],
  ["jobs.length < 10", "count < 10", 0],
  ["jobs.length < 10", "count >= 0", 1],
  ["jobs.length !== 10", "jobs.length !== 10", 0],
  ["jobs.length !== 10", "jobs.length !== 11", 1],
]) {
  test(`shared producer follows independent guards ${first} / ${second}`, async () => {
    const setup = "function enqueue(value) { ++count; jobs.push(value); }";
    assert.equal((await audit(route(`${first} && enqueue(req.url);`) + route(`${second} && enqueue(req.url);`), { setup })).length, expected);
  });
}

test("checking one queue's length does not guard its neighbor", async () => {
  const setup = "const other = []; setInterval(() => work(other.shift()), 100);";
  const findings = await audit(route("if (jobs.length >= 10) return; jobs.push(req.url); other.push(req.url);"), { setup });
  assert.equal(findings.length, 1);
  assert.match(findings[0].snippet, /other\.push/);
});

for (const producer of [push, "enqueue(req.url)"]) {
  const setup = "function enqueue(value) { jobs.push(value); }";
  for (const [name, body, expected] of [
    ["request-sized for-of batch", `if (jobs.length >= 10) return; for (const v of req.items) { ${producer}; }`, 1],
    ["per-item admission", `for (const v of req.items) { if (jobs.length >= 10) return; ${producer}; }`, 0],
    ["request-sized batch with a single iteration", `if (jobs.length >= 10) return; for (const v of req.items) { ${producer}; break; }`, 0],
    ["fixed batch", `if (jobs.length >= 10) return; for (const v of [1,2]) { ${producer}; }`, 0],
    ["counted finite batch", `if (jobs.length >= 10) return; for (let i=0; i<2; i++) { ${producer}; }`, 0],
    ["request-sized counted batch", `if (jobs.length >= 10) return; for (let i=0; i<req.size; i++) { ${producer}; }`, 1],
    ["unbounded continuing branch", `if (jobs.length >= 10) return; while (req.url) { if (req.url === '/') { await load(); break; } ${producer}; }`, 1],
    ["rechecked loop condition", `while (req.open && jobs.length < 10) { ${producer}; }`, 0],
    ["condition based on a stale snapshot", `const n = jobs.length; while (req.open && n < 10) { ${producer}; }`, 1],
    ["rechecked single-iteration condition", `while (jobs.length < 10) { ${producer}; break; }`, 0],
  ]) test(`${name} with ${producer}`, async () => {
    assert.equal((await audit(route(body), { setup })).length, expected);
  });
}

test("a counter checked once cannot limit the continuing branch of a request-sized loop", async () => {
  const setup = "function enqueue(value) { jobs.push(value); count++; }";
  const body = "while (req.url) { if (req.url === '/') { await load(); break; } enqueue(req.url); }";
  assert.equal((await audit(route("if (count >= 10) return;" + body), { setup })).length, 1);
});

for (const [sibling, expected] of [
  ["export function copy() { return Array.prototype.slice.call(arguments); }", 1],
  ["export function copy() { return globalThis.Array['prototype']['slice'].call(arguments); }", 1],
  ["export const timerAvailable = typeof globalThis.setInterval === 'function';", 1],
  ["export const timerAvailable = typeof globalThis['setInterval'] === 'function';", 1],
  ["export const enabled = typeof Array.prototype[method] === 'function';", 1],
  ["Array.prototype.push = function () { return 0; };", 0],
  ["[Array.prototype.shift] = [fallback];", 0],
  ["patch(Array.prototype);", 0],
  ["patch(Array.prototype.valueOf());", 0],
  ["Array.prototype.install();", 0],
  ["Object.defineProperty(Array.prototype, 'push', replacement);", 0],
  ["globalThis.setInterval = fallback;", 0],
  ["const host = globalThis; host[computed()] = replacement;", 0],
]) {
  test(`queue evidence across sibling use ${sibling}`, async () => {
    assert.equal((await audit(route(push), { sibling })).length, expected);
  });
}

test("shared length guards and nested producer sites stay within the existing work limit", async () => {
  const setup = "function available() { return jobs.length < 10; } function enqueue(value) { jobs.push(value); }";
  const body = route("available() && enqueue(req.url);");
  const measure = async size => {
    const take = AnalysisBudget.prototype.take;
    let work = 0;
    AnalysisBudget.prototype.take = function (units = 1) {
      if (this.label === "Queue backpressure") work += units;
      return take.call(this, units);
    };
    try {
      const report = await audit(body.repeat(size), { setup, run: runAudit });
      assert.equal(report.complete, true);
      assert.equal(report.findings.filter(finding => finding.id === "unbounded-request-queue").length, 0);
      return work;
    } finally {
      AnalysisBudget.prototype.take = take;
    }
  };
  const first = await measure(40);
  assert.ok(await measure(80) < first * 2.5);
});
