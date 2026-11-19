import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";

async function audit(source) {
  const root = await mkdtemp(join(tmpdir(), "scale-queue-strict-result-"));
  try {
    await writeFile(join(root, "server.ts"), source);
    return await detectQueueBackpressure(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const http = "import { createServer } from 'node:http';";
const queues = `
  ${http}
  const fast = [], slow = [];
  let fastCount = 0, slowCount = 0;
  function enqueueBoth(job) {
    fast.push(job); fastCount++;
    slow.push(job); slowCount++;
  }
  function drainFast(job) { if (job !== undefined) fastCount--; }
  function drainSlow(job) { if (job !== undefined) slowCount--; }
  setInterval(() => drainFast(fast.shift()), 10);
  setInterval(() => drainSlow(slow.shift()), 1000);
  function full() { return fastCount >= 10; }
  function available() { return fastCount < 10; }
`;

const enqueue = "enqueueBoth(req.url);";

function queuesReported(findings) {
  return findings.map(finding => finding.snippet.split("\n")[1].match(/\b(fast|slow)\.push\b/)?.[1]).sort();
}

for (const condition of [
  "(full() || req.url) === true",
  "true === (full() || req.url)",
  "!(true !== (full() || req.url))",
  "!((full() || req.url) !== true)",
  "(available() && req.url) === false",
  "false === (available() && req.url)",
  "!(false !== (available() && req.url))",
  "true !== !(full() || req.url)",
  "false !== (req.url || full())",
  "(req.url && available()) !== true",
  "(full() || 1) === true",
  "(available() && '') === false",
  "(full() ? true : req.url) === true",
  "(available() ? req.url : false) === false",
  "(full() ? full() : req.url) === true",
  "(available() ? req.url : available()) === false",
  "((full() || req.url) ?? false) === true",
  "Boolean(req.url || full()) === true",
  "!!(req.url || full()) === true",
]) {
  test(`${condition} rejects a full fast queue without bounding the slow queue`, async () => {
    const source = `${queues} createServer(req => { if (${condition}) return; ${enqueue} });`;
    assert.deepEqual(queuesReported(await audit(source)), ["slow"]);
  });
}

for (const condition of [
  "(req.url || full()) === true",
  "true === (req.url || full())",
  "(req.url && available()) === false",
  "(1 || full()) === true",
  "('' && available()) === false",
  "(req.url ? 1 : full()) === true",
  "(req.url ? 0 : available()) === false",
  "(full() || req.url) !== true",
  "(full() ? full() : full()) !== true",
  "(available() ? available() : available()) !== false",
]) {
  test(`${condition} can still admit jobs while the fast queue is full`, async () => {
    // Make the tested full state reachable. Inverted Boolean guards can reject
    // every request from an initially empty queue, which is safely bounded.
    const source = `${queues.replace("fastCount = 0", "fastCount = 10")} createServer(req => { if (${condition}) return; ${enqueue} });`;
    assert.deepEqual(queuesReported(await audit(source)), ["fast", "slow"]);
  });
}

for (const [condition, expected] of [
  ["(full() || req.url) !== true", ["slow"]],
  ["true !== (req.url || full())", ["fast", "slow"]],
]) {
  test(`${condition} retains the same queue identity when it directly controls the enqueue`, async () => {
    const source = `${queues} createServer(req => { if (${condition}) { ${enqueue} } });`;
    assert.deepEqual(queuesReported(await audit(source)), expected);
  });
}

test("strict Boolean proof follows a helper's return but never reuses a shadowed binding", async () => {
  const helper = "function mixed() { return full() || process.env.PATH_HINT; }";
  const native = `${queues} ${helper} createServer(req => { if (mixed() === true) return; ${enqueue} });`;
  const shadowed = `${queues} ${helper} createServer(req => {
    const mixed = () => req.url || full();
    if (mixed() === true) return;
    ${enqueue}
  });`;
  assert.deepEqual(queuesReported(await audit(native)), ["slow"]);
  assert.deepEqual(queuesReported(await audit(shadowed)), ["fast", "slow"]);
});

test("a shadowed Boolean wrapper cannot certify the underlying guard", async () => {
  const source = `${queues} createServer(req => {
    const Boolean = () => false;
    if (Boolean(full() || req.url) === true) return;
    ${enqueue}
  });`;
  assert.deepEqual(queuesReported(await audit(source)), ["fast", "slow"]);
});

for (const [condition, expected] of [
  ["Boolean(full()) || fastCount >= 10", ["slow"]],
  ["(Boolean(full()) || fastCount >= 10) === true", ["fast", "slow"]],
  ["(fastCount >= 10 || Boolean(full())) === true", ["slow"]],
]) {
  test(`a replaced Boolean contributes no result guarantee to ${condition}`, async () => {
    const source = `${queues}
      globalThis.Boolean = () => 'yes';
      createServer(req => { if (${condition}) return; ${enqueue} });
    `;
    assert.deepEqual(queuesReported(await audit(source)), expected);
  });
}

test("strict and truthiness views of the same helper remain independent of lookup order", async () => {
  const helper = "const mixed = () => req.url || full();";
  const truthy = `if (mixed()) return; ${enqueue}`;
  const strict = `if (mixed() === true) return; ${enqueue}`;
  assert.deepEqual(queuesReported(await audit(`${queues} createServer(req => { ${helper} ${truthy} });`)), ["slow"]);
  for (const [first, second] of [[truthy, strict], [strict, truthy]]) {
    const source = `${queues} createServer(req => {
      ${helper}
      if (req.url === '/first') { ${first} return; }
      ${second}
    });`;
    assert.deepEqual(queuesReported(await audit(source)), ["fast", "slow"]);
  }
});

function singleQueue(body, startup = "", initial = 0) {
  return `
      ${http}
      const fast = [];
      let fastCount = ${initial};
      function enqueue(job) { fast.push(job); fastCount++; }
      function drain(job) { if (job !== undefined) fastCount--; }
      setInterval(() => drain(fast.shift()), 10);
      function full() { return fastCount >= 10; }
      function available() { return fastCount < 10; }
      ${startup}
      createServer(req => { ${body} enqueue(req.url); });
  `;
}

for (const [condition, expected] of [
  ["(full() || req.url) === true", []],
  ["(req.url || full()) === true", ["fast"]],
  ["available() === true", ["fast"]],
  ["(full() && available()) === true", ["fast"]],
]) {
  test(`a lone queue requires valid strict comparison evidence from ${condition}`, async () => {
    const source = singleQueue(`if (${condition}) return;`, "", condition === "available() === true" ? 10 : 0);
    assert.deepEqual(queuesReported(await audit(source)), expected);
  });
}

test("a rejected Boolean preserves an independent unit scalar gate", async () => {
  const startup = "globalThis.Boolean = () => false;";
  const uncertain = "if (Boolean(fastCount === 11)) return;";
  const mention = "if (fastCount === 11) return;";
  assert.deepEqual(queuesReported(await audit(singleQueue(uncertain, startup))), ["fast"]);
  for (const checks of [`${mention} ${uncertain}`, `${uncertain} ${mention}`]) {
    assert.deepEqual(queuesReported(await audit(singleQueue(checks, startup))), []);
  }
});

test("a repeated nested ternary guard shares selector and arm proofs", async () => {
  const depth = 24;
  const helpers = ["function check0() { return full(); }"];
  for (let i = 1; i <= depth; i++) {
    const previous = `check${i - 1}()`;
    helpers.push(`function check${i}() { return ${previous} ? ${previous} : process.env.PATH_HINT; }`);
  }
  const checkedEnqueue = `if (check${depth}() === true) return; ${enqueue}\n`;
  const source = `${queues}
    ${helpers.join("\n")}
    createServer(req => { ${checkedEnqueue.repeat(350)} });
  `;
  assert.deepEqual(queuesReported(await audit(source)), ["slow"]);
});

test("many strict comparisons of one wide mixed guard reuse the capacity proof", async () => {
  const boundCount = 220;
  const indices = Array.from({ length: boundCount + 1 }, (_, index) => index);
  function disjunction(first, last) {
    if (last - first === 1) return `count${first} >= 10`;
    const middle = (first + last) >>> 1;
    return `(${disjunction(first, middle)} || ${disjunction(middle, last)})`;
  }
  const declarations = indices.map(index => `const q${index} = []; let count${index} = 0;`).join("\n");
  const enqueues = indices.map(index => `q${index}.push(job); count${index}++;`).join("\n");
  const workers = indices.map(index => `
    function drain${index}(job) { if (job !== undefined) count${index}--; }
    setInterval(() => drain${index}(q${index}.shift()), 10);
  `).join("\n");
  const guardedRoute = "if ((full() || req.url) === true) return; enqueueBoth(req.url);\n";
  const source = `
    ${http}
    ${declarations}
    function enqueueBoth(job) { ${enqueues} }
    ${workers}
    function full() { return ${disjunction(0, boundCount)}; }
    createServer(req => { ${guardedRoute.repeat(350)} });
  `;
  const findings = await audit(source);
  assert.equal(findings.length, 1);
  assert.match(findings[0].snippet.split("\n")[1], /q220\.push/);
});
