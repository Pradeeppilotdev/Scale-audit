import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";

const guard = "if (outstanding >= 10) return;";
const enqueue = "enqueue(req.url);";

async function findings(body) {
  const root = await mkdtemp(join(tmpdir(), "scale-queue-completion-"));
  try {
    await writeFile(join(root, "server.ts"), `
      import { createServer } from 'node:http';
      const jobs: string[] = [];
      let outstanding = 0;
      function enqueue(job: string) { jobs.push(job); outstanding++; }
      function work(job: string | undefined) { if (job !== undefined) outstanding--; }
      setInterval(() => work(jobs.shift()), 100);
      createServer(async req => { ${body} });
    `);
    return await detectQueueBackpressure(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const loop of ["for (const job of [])", "for (let i = 3; i < 2; i++)"]) {
  test(`zero-iteration ${loop} skips direct enqueues and helper calls`, async () => {
    assert.deepEqual(await findings(`${loop} { jobs.push(req.url); ${enqueue} }`), []);
    assert.deepEqual(await findings(`${guard} ${loop} { await load(); } ${enqueue}`), []);
  });
}

for (const [loop, risk] of [
  ["for (const { value = await load() } of [])", false],
  ["for (const { value = await load() } of [{value: 1}, {value: 2}])", false],
  ["for (const [value = await load()] of [[1], [2]])", false],
  ["for (const [value = await load()] of [[1], []])", true],
  ["for (const { value = await load() } of [{value: 1}, {}])", true],
  ["for (const { __proto__ = await load() } of [{__proto__: null}])", true],
  ["for (const { [await load()]: value } of [{value: 1}])", true],
  ["for await (const job of [])", true],
  ["for (let i = await load(); false; i++)", true],
]) {
  test(`${loop} ${risk ? "can" : "cannot"} suspend before the following enqueue`, async () => {
    assert.equal((await findings(`${guard} ${loop} {} ${enqueue}`)).length, Number(risk));
  });
}

const terminalSearch = "switch (req.url) { case '/': break; case await load(): return; default: return; }";

test("a switch test that only reaches terminal clauses preserves admission", async () => {
  assert.deepEqual(await findings(`${guard} ${terminalSearch} ${enqueue}`), []);
});

test("a rejected switch test can resume into a catch that reaches the enqueue", async () => {
  assert.equal((await findings(`${guard} try { ${terminalSearch} } catch {} ${enqueue}`)).length, 1);
});

test("an unmatched switch can reach the enqueue after evaluating an awaited test", async () => {
  const statement = "switch (req.url) { case '/': break; case await load(): return; }";
  assert.equal((await findings(`${guard} ${statement} ${enqueue}`)).length, 1);
});

test("a duplicate switch case can only be reached by falling through", async () => {
  const statement = "switch(req.url) { case '/': break; case '/': await load(); break; default: return; }";
  assert.deepEqual(await findings(`${guard} ${statement} ${enqueue}`), []);
  assert.deepEqual(await findings(`switch (req.url) { case '/': ${guard} case '/': ${enqueue} break; }`), []);
  assert.deepEqual(await findings(`switch (req.url) { case '/': break; case '/': ${enqueue} break; }`), []);
});

for (const branch of [
  "if (req.url) { await load(); return; }",
  "if (req.url) { switch (0) { case 0: return; } await load(); }",
]) {
  test(`nested loop summaries share the proof for ${branch}`, async () => {
    const depth = 30;
    const body = "for (let i = 0; i < 2; i++) {".repeat(depth) + (branch + "\n").repeat(3000)
      + enqueue + "await load();" + "}".repeat(depth);
    assert.equal((await findings(`${guard} ${body}`)).length, 1);
  });
}

test("cached repeated-loop waits respect a labeled continuation", async () => {
  const loops = `outer: for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      ${enqueue}
      if (req.url) { await load(); continue outer; }
    }
  }`;
  assert.equal((await findings(`${guard} ${loops}`)).length, 1);
});
