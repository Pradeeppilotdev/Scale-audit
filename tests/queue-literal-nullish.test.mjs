import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";
import { detectSyncIo } from "../dist/detectors/syncIo.js";

async function audit(source, detector = detectQueueBackpressure) {
  const root = await mkdtemp(join(tmpdir(), "scale-queue-nullish-"));
  try {
    await writeFile(join(root, "server.ts"), source);
    return await detector(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const setup = `import { createServer } from 'node:http';
  const fast = [], slow = [];
  let fastCount = 0, slowCount = 0;
  function full() { return fastCount >= 10; }
  function available() { return fastCount < 10; }
  function enqueue(job) {
    fast.push(job); fastCount++;
    slow.push(job); slowCount++;
  }
  function drainFast(job) { if (job !== undefined) fastCount--; }
  function drainSlow(job) { if (job !== undefined) slowCount--; }
  setInterval(() => drainFast(fast.shift()), 10);
  setInterval(() => drainSlow(slow.shift()), 1000);
`;

function reported(findings) {
  return findings.map(finding => finding.snippet.split("\n")[1].match(/\b(fast|slow)\.push\b/)?.[1]).sort();
}

for (const condition of [
  "(available() ? 0 : true) === true",
  "(full() ? true : 0) === true",
  "(available() ? 0 : false) === false",
  "(full() ? false : 0) === false",
  "true === (available() ? '' : true)",
  "!((full() ? false : 1) !== false)",
  "((full() ? null : req.url) ?? false) === false",
  "false === ((available() ? req.url : undefined) ?? false)",
  "((full() ? void effect() : req.url) ?? false) === false",
  "((full() ? null : req.url) ?? false) !== true",
  "!(((full() ? null : req.url) ?? false) !== false)",
]) {
  test(`${condition} protects only the fast queue`, async () => {
    const findings = await audit(`${setup} createServer(req => { if (${condition}) return; enqueue(req.url); });`);
    assert.deepEqual(reported(findings), ["slow"]);
  });
}

for (const [condition, initial] of [
  ["((full() ? 0 : req.url) ?? false) === false", 0],
  ["((full() ? '' : req.url) ?? false) === false", 0],
  ["((full() ? null : req.url) ?? false) === true", 0],
  ["((full() ? null : req.url) ?? false) !== false", 0],
  ["(available() ? true : 0) === true", 10],
  ["(available() ? false : 0) === false", 10],
]) {
  test(`${condition} cannot donate a matching Boolean result`, async () => {
    // The inverted available() policies reject every request when count starts
    // at zero. Start those at ten to exercise the admitted, unbounded region.
    const source = setup.replace("let fastCount = 0", `let fastCount = ${initial}`);
    const findings = await audit(`${source} createServer(req => { if (${condition}) return; enqueue(req.url); });`);
    assert.deepEqual(reported(findings), ["fast", "slow"]);
  });
}

for (const condition of ["(available() ? true : 0) === true", "(available() ? false : 0) === false"]) {
  test(`${condition} cannot reach a full fast queue from its initial zero count`, async () => {
    const findings = await audit(`${setup} createServer(req => { if (${condition}) return; enqueue(req.url); });`);
    assert.ok(!reported(findings).includes("fast"));
  });
}

for (const condition of ["(available() ? true : true) === true", "(full() ? false : false) === false"]) {
  test(`${condition} leaves no reachable enqueue`, async () => {
    assert.deepEqual(await audit(`${setup} createServer(req => { if (${condition}) return; enqueue(req.url); });`), []);
  });
}

test("nullish fallback and exact-false helper proofs do not share cache modes", async () => {
  const helper = "function decide() { return full() ? null : process.env.INPUT; }";
  const exact = "if (decide() === false) return; enqueue(req.url);";
  const fallback = "if ((decide() ?? false) === false) return; enqueue(req.url);";
  assert.deepEqual(reported(await audit(`${setup}${helper} createServer(req => { ${fallback} });`)), ["slow"]);
  assert.deepEqual(reported(await audit(`${setup}${helper} createServer(req => { ${exact} });`)), ["fast", "slow"]);
  for (const [first, second] of [[exact, fallback], [fallback, exact]]) {
    assert.deepEqual(reported(await audit(`${setup}${helper} createServer(req => {
      if (req.url === '/first') { ${first} return; }
      ${second}
    });`)), ["fast", "slow"]);
    assert.deepEqual(reported(await audit(`${setup}${helper}
      createServer(req => { ${first} });
      createServer(req => { ${second} });`)), ["fast", "slow"]);
  }
});

test("constant ternary results retain evaluated I/O and exclude their unreachable tail", async () => {
  const findings = await audit(`import { createServer } from 'node:http';
    import { readFileSync } from 'node:fs';
    createServer(() => {
      if ((readFileSync('selector') ? true : true) === true) return;
      readFileSync('unreachable');
    });`, detectSyncIo);
  assert.deepEqual(findings.filter(finding => finding.severity === "high").map(finding => finding.line), [4]);
});

test("a folded ternary condition still invalidates capacity when its selector awaits", async () => {
  const findings = await audit(`${setup} createServer(async req => {
    if (full()) return;
    if (((await load()) ? true : true) === false) return;
    enqueue(req.url);
  });`);
  assert.deepEqual(reported(findings), ["fast", "slow"]);
});

test("repeated exact-nullish guards share a wide helper's capacity proof", async () => {
  const count = 220;
  const queues = Array.from({ length: count + 1 }, (_, i) => i);
  function condition(first, last) {
    if (last - first === 1) return `count${first} >= 10`;
    const middle = (first + last) >>> 1;
    return `(${condition(first, middle)} || ${condition(middle, last)})`;
  }
  const declarations = queues.map(i => `const q${i} = []; let count${i} = 0;`).join("\n");
  const enqueues = queues.map(i => `q${i}.push(job); count${i}++;`).join("\n");
  const drains = queues.map(i => `function drain${i}(job) { if (job !== undefined) count${i}--; }
    setInterval(() => drain${i}(q${i}.shift()), 10);`).join("\n");
  const guard = "if (((full() ? null : req.url) ?? false) === false) return; enqueue(req.url);\n";
  const findings = await audit(`import { createServer } from 'node:http';
    ${declarations}
    function enqueue(job) { ${enqueues} }
    ${drains}
    function full() { return ${condition(0, count)}; }
    createServer(req => { ${guard.repeat(350)} });`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].snippet.split("\n")[1], /q220\.push/);
});
