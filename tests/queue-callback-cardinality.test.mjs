import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";
import { detectSyncIo } from "../dist/detectors/syncIo.js";

async function withSource(source, detector = detectQueueBackpressure) {
  const root = await mkdtemp(join(tmpdir(), "scale-callback-cardinality-"));
  try {
    await writeFile(join(root, "server.ts"), source);
    return await detector(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function queueSource(body, extra = "") {
  return `import { createServer } from 'node:http';
    const jobs = []; let count = 0;
    function full() { return count >= 11; }
    function drain(job) { if (job !== undefined) count--; }
    setInterval(() => drain(jobs.shift()), 100);
    globalThis.Boolean = () => false;
    ${extra}
    createServer(req => {
      if (count === 11) return;
      if (Boolean(full())) return;
      ${body}
    });`;
}

// These fixed test expressions run against native JavaScript to establish the
// expected invocation count. The source given to the auditor is never executed.
function nativeCount(invocation, result = "false") {
  let calls = 0;
  const returns = new Function("item", `return ${result};`);
  new Function("callback", `${invocation};`)(item => { calls++; return returns(item); });
  return calls;
}

for (const method of ["forEach", "map", "flatMap", "filter", "some", "every"]) {
  const result = method === "every" || method === "filter" ? "true" : method === "flatMap" ? "[item]" : "false";
  for (const collection of ["[, 1]", "[1, ,]", "[, , 1, ,]", "[1, , 2]"]) {
    const expression = `${collection}.${method}(callback)`;
    test(`${expression} uses the number of present elements`, async () => {
      const calls = nativeCount(expression, result);
      const callback = `item => { jobs.push(item); count++; return ${result}; }`;
      const findings = await withSource(queueSource(`${collection}.${method}(${callback});`));
      assert.equal(findings.length, calls > 1 ? 1 : 0, `native callbacks: ${calls}`);
    });
  }
}

for (const expression of [
  "[, 1].find(callback)",
  "[, 1].findIndex(callback)",
  "Array.from([, 1], callback)",
  "Array.from([, 1]).forEach(callback)",
  "Array.from(new Array(20)).forEach(callback)",
]) {
  test(`${expression} retains repeated callbacks through holes or compact shapes`, async () => {
    assert.ok(nativeCount(expression) > 1);
    const invocation = expression.replace("callback", "item => { jobs.push(item); count++; return false; }");
    assert.equal((await withSource(queueSource(invocation))).length, 1);
  });
}

for (const source of ["'😀'", "'😀x'", "'😀😀'", "'\\ud83d'", "''", "{ length: 1.9 }", "{ length: +1.9 }",
  "{ length: 0.9 }", "{ length: -1 }", "{ length: 2.9 }"]) {
  for (const chained of [false, true]) {
    const expression = chained ? `Array.from(${source}).forEach(callback)` : `Array.from(${source}, callback)`;
    test(`${expression} respects native iteration and length normalization`, async () => {
      const calls = nativeCount(expression);
      const invocation = expression.replace("callback", "item => { jobs.push(item); count++; }");
      assert.equal((await withSource(queueSource(invocation))).length, calls > 1 ? 1 : 0, `native callbacks: ${calls}`);
    });
  }
}

for (const values of ["[, 1]", "[1, , 2]"]) {
  for (const reverse of [false, true]) {
    test(`shared callback metadata preserves ${values} cardinality in either invocation order (${reverse})`, async () => {
      const extra = `function enqueue(item) { jobs.push(item); count++; }
        function each(items) { items.forEach(enqueue); }`;
      const calls = [`each([, 1]);`, `each(${values});`];
      if (reverse) calls.reverse();
      // Separate routes each perform one native operation. A shared helper
      // keeps the wider invocation when both shapes reach the same callback.
      const source = queueSource(calls[0], extra)
        + `createServer(req => { if (count === 11) return; if (Boolean(full())) return; ${calls[1]} });`;
      assert.equal((await withSource(source)).length, values === "[, 1]" ? 0 : 1);
    });
  }
}

for (const mutation of [
  "String.prototype[Symbol.iterator] = function* () { yield 1; yield 2; };",
  "const proto = String.prototype; Object.defineProperty(proto, Symbol.iterator, { value: function* () { yield 1; yield 2; } });",
  "globalThis.String.prototype[Symbol.iterator] = function* () { yield 1; yield 2; };",
  "globalThis['String'].prototype[Symbol.iterator] = function* () { yield 1; yield 2; };",
  "const host = globalThis; host.String.prototype[Symbol.iterator] = function* () { yield 1; yield 2; };",
  "const define = Object.defineProperty; define(globalThis.String.prototype, Symbol.iterator, { value: function* () { yield 1; yield 2; } });",
]) {
  test(`a replaced string iterator cannot prove a single callback: ${mutation}`, async () => {
    const body = "Array.from('😀', item => { jobs.push(item); count++; });";
    assert.equal((await withSource(queueSource(body, mutation))).length, 1);
  });
}

for (const expression of ["Array.from({ length: 0.9 }, callback)", "Array.from({ length: -1 }).forEach(callback)",
  "[, 1].sort(callback)"]) {
  test(`${expression} has no request callback work`, async () => {
    assert.equal(nativeCount(expression), 0);
    const findings = await withSource(`import { createServer } from 'node:http';
      import { readFileSync } from 'node:fs';
      function callback() { readFileSync('should-not-run'); }
      createServer(() => { ${expression}; });`, detectSyncIo);
    assert.equal(findings.filter(finding => finding.severity === "high").length, 0);
  });
}

test("a long string does not consume per-character analysis work just to reject unit cardinality", async () => {
  const source = `import { createServer } from 'node:http';
    import { readFileSync } from 'node:fs';
    const text = '${"x".repeat(250_000)}';
    createServer(() => Array.from(text, () => readFileSync('work')));`;
  const findings = await withSource(source, detectSyncIo);
  assert.equal(findings.filter(finding => finding.severity === "high").length, 1);
});
