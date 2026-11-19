import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";
import { detectSyncIo } from "../dist/detectors/syncIo.js";

async function audit(condition, { body, declarations = "", async = false, detector = detectQueueBackpressure } = {}) {
  const root = await mkdtemp(join(tmpdir(), "scale-computed-neutral-"));
  try {
    await writeFile(join(root, "server.ts"), `import { createServer } from 'node:http';
      const fast = [], slow = []; let fc = 0, sc = 0;
      function full() { return fc >= 10; }
      function available() { return fc < 10; }
      function enqueue(job) {
        fast.push(job); fc++;
        slow.push(job); sc++;
      }
      function drainFast(job) { if (job !== undefined) fc--; }
      function drainSlow(job) { if (job !== undefined) sc--; }
      setInterval(() => drainFast(fast.shift()), 10);
      setInterval(() => drainSlow(slow.shift()), 1000);
      ${declarations}
      createServer(${async ? "async " : ""}req => {
        ${body ?? `if (${condition}) return; enqueue(req.url);`}
      });`);
    return await detector(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function reported(findings) {
  return findings.map(finding => finding.snippet.split("\n")[1].match(/\b(fast|slow)\.push/)?.[1]).sort();
}

for (const condition of [
  "(true === true) && full()", "full() && (true === true)",
  "((full() ? true : true) && full()) === true",
  "(full() && (req.url ? true : true)) === true",
  "((req.url ? false : false) || full()) === true",
  "(full() || (false !== false)) === true",
  "((true === true) ? full() : false) === true",
  "((false !== false) ? true : full()) === true",
  "full() === (true === true)", "(false !== false) === available()",
  "((1 === false) || full()) === true", "((1 !== false) && full()) === true",
  "(1 && full()) === true", "('' || full()) === true",
]) {
  test(`${condition} protects only its own queue`, async () => {
    assert.deepEqual(reported(await audit(condition)), ["slow"]);
  });
}

for (const condition of [
  "(full() && (req.url ? 1 : 1)) === true",
  "(available() || (req.url ? 0 : 0)) === false",
  "(req.url ? 1 : full()) === true",
  "(req.url || full()) === true",
  "((req.url ? true : false) && full()) === true",
]) {
  test(`${condition} does not mistake a truthy or conditional result for a fixed Boolean`, async () => {
    assert.deepEqual(reported(await audit(condition)), ["fast", "slow"]);
  });
}

test("a constant Boolean selector still evaluates its request I/O", async () => {
  const findings = await audit("(readFileSync('selector') ? true : true) && full()", {
    declarations: "import { readFileSync } from 'node:fs';", detector: detectSyncIo,
  });
  assert.equal(findings.filter(finding => finding.severity === "high" && /selector/.test(finding.snippet)).length, 1);
});

test("an evaluated wait inside a constant Boolean operand invalidates the earlier check", async () => {
  const body = "if (full()) return; if ((((await load()) ? true : true) && false) === true) return; enqueue(req.url);";
  assert.deepEqual(reported(await audit("", { body, async: true })), ["fast", "slow"]);
});

test("computed-neutral and strict helper views stay independent in either cache order", async () => {
  const declarations = "function mixed() { return full() || process.env.CAPACITY_HINT; }";
  const protected_ = "if ((true === true) && mixed()) return; enqueue(req.url);";
  const unprotected = "if (((true === true) && mixed()) !== true) return; enqueue(req.url);";
  for (const [first, second] of [[protected_, unprotected], [unprotected, protected_]]) {
    const body = `if (req.url === '/first') { ${first} return; } ${second}`;
    assert.deepEqual(reported(await audit("", { declarations, body })), ["fast", "slow"]);
  }
});

test("repeated computed-neutral checks reuse the shared expression analysis", async () => {
  const guard = "if (((full() ? true : true) && full()) === true) return; enqueue(req.url);\n";
  assert.deepEqual(reported(await audit("", { body: guard.repeat(700) })), ["slow"]);
});
