import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";

async function audit(files) {
  const root = await mkdtemp(path.join(tmpdir(), "scale-queue-"));
  try {
    for (const [file, contents] of Object.entries(files)) {
      const target = path.join(root, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    }
    return await detectQueueBackpressure(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const server = "import { createServer } from 'node:http';";
const queue = "const jobs: unknown[] = [];";
const worker = "function work(job: unknown) { console.log(job); }";
const request = "createServer((req, res) => { jobs.push(req.url); res.end('ok'); });";
const interval = "setInterval(() => { const job = jobs.shift(); if (job !== undefined) work(job); }, 250);";

const cases = {
  "visible native HTTP producer and serialized interval consumer": [server, queue, worker, request, interval],
  "request prepares a job before enqueue and logs queue depth afterward": [
    server, queue, worker, interval,
    "createServer((req, res) => { const job = req.url; jobs.push(job); console.log(jobs.length); res.end(); });",
  ],
  "a shadowed logger receives only a numeric depth": [
    server, queue, worker, interval,
    "const console = capacityService; createServer(req => { console.log(jobs.length); jobs.push(req.url); });",
  ],
  "direct enqueue helper can follow ordinary request logging": [
    server, queue, worker, interval, "function enqueue(job: unknown) { jobs.push(job); }",
    "createServer(req => { console.log(req.url); enqueue(req.url); });",
  ],
  "worker is read at first tick after synchronous module startup": [
    server, queue, request, "setInterval(() => work(jobs.shift()), 250);",
    "const work = (job: unknown) => { console.log(job); };",
  ],
  "unguarded native call remains visible beside a guarded direct helper call": [
    server, queue, "let outstanding = 0;", "function work(job: unknown) { outstanding--; }", interval,
    "function enqueue(job: unknown) { jobs.push(job); outstanding++; }",
    "createServer(req => { if (outstanding >= 10) return; enqueue(req.url); });",
    "createServer(req => enqueue.call(null, req.url));",
  ],
  "framework route reaches a local enqueue helper": [
    "import express from 'express'; const app = express();", queue, worker,
    "function enqueue(job: unknown) { jobs.push(job); }",
    "app.post('/jobs', (req, res) => { enqueue(req.body); res.sendStatus(202); });", interval,
  ],
  "exported route reaches a same-module helper": [
    queue, worker, "function enqueue(job: unknown) { jobs.push(job); }",
    "export function POST(request: Request) { enqueue(request.url); }", interval,
  ],
  "top-level timer assignment with named drain and empty guard": [
    server, queue, worker, request,
    "function drain() { if (!jobs.length) return; const job = jobs.pop(); if (!job) return; void work(job); }",
    "const timer = setInterval(drain, 250); timer.unref();",
  ],
  "concise producer and consumer arrows": [
    server, "const jobs = ([] as unknown[]);", "const work = (job: unknown) => { console.log(job); };",
    "createServer(req => jobs.push(req.url));",
    "setInterval(() => work(jobs.shift()), 50);",
  ],
  "unrelated shadowed queue uses do not suppress exact binding": [
    server, queue, worker, request, interval,
    "function other(jobs: unknown[]) { return jobs.length; }",
  ],
  "a second unguarded request still reaches a shared helper": [
    server, queue, worker, "function enqueue(job: unknown) { jobs.push(job); }", "let outstanding = 0;",
    "createServer(() => { if (outstanding >= 10) return; enqueue(1); });",
    "createServer(() => enqueue(1));", interval,
  ],
};

for (const [name, source] of Object.entries(cases)) {
  test(name, async () => {
    const findings = await audit({ "api/queue.ts": source.join("\n") });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, "unbounded-request-queue");
    assert.equal(findings[0].file, "api/queue.ts");
    assert.equal(findings[0].severity, "medium");
    assert.equal(findings[0].confidence, "high");
    assert.match(findings[0].message, /private queue \(line \d+\).*line \d+.*dequeues at most one job.*line \d+/);
    assert.match(findings[0].snippet, /jobs\.push/);
  });
}

test("an unincremented counter cannot protect an enqueue helper", async () => {
  const findings = await audit({ "server.ts": [server, queue, worker,
    "function enqueue(job: unknown) { jobs.push(job); }", "let outstanding = 0;",
    "createServer(() => { if (outstanding >= 10) return; enqueue(1); });", interval].join("\n") });
  assert.equal(findings.length, 1);
});

const negatives = {
  "push alone does not establish a queue": [server, queue, worker, request],
  "arbitrary background producer is not a request": [queue, worker, "function background(job: unknown) { jobs.push(job); }", interval],
  "unknown external request callback is only possibly invoked": [server, queue, worker, "createServer(() => maybe(() => jobs.push(1)));", interval],
  "earlier handler return excludes an unreachable producer": [server, queue, worker, "createServer(() => { return; jobs.push(1); });", interval],
  "handler admission with a queue length check": [server, queue, worker, "createServer(() => { if (jobs.length >= 10) return; jobs.push(1); });", interval],
  "an independent capacity counter is visible before enqueue": [server, queue, worker, "let outstanding = 0; createServer(() => { if (outstanding >= 10) return; jobs.push(1); outstanding++; });", interval],
  "callsite capacity check protects an enqueue helper": [server, queue, worker, "function enqueue(job: unknown) { jobs.push(job); }", "createServer(() => { if (jobs.length < 10) enqueue(1); });", interval],
  "callsite capacity counter protects a native call to an enqueue helper": [
    server, queue, "let outstanding = 0;", "function work(job: unknown) { outstanding--; }", interval,
    "function enqueue(job: unknown) { jobs.push(job); outstanding++; }",
    "createServer(req => { if (outstanding >= 10) return; enqueue.call(null, req.url); });",
  ],
  "startup suspension prevents proving a late worker is ready on the first tick": [
    server, queue, request, "setInterval(() => work(jobs.shift()), 250);",
    "await start(); const work = (job: unknown) => { console.log(job); };",
  ],
  "startup suspension within a shared declaration precedes a late worker": [
    server, queue, request, "setInterval(() => work(jobs.shift()), 250);",
    "const delayed = await start(), work = (job: unknown) => { console.log(job); };",
  ],
  "capacity helper's length reference also protects enqueue": [server, queue, worker, "function hasRoom() { return jobs.length < 10; }", "createServer(() => { if (hasRoom()) jobs.push(1); });", interval],
  "caller trims an in-process ring buffer": [server, queue, worker, "createServer(() => { jobs.push(1); jobs.shift(); });", interval],
  "unrelated shadowed array is consumed": [server, queue, worker, request, "setInterval(() => { const jobs: unknown[] = []; work(jobs.shift()); }, 250);"],
  "queue is exported by its declaration": [server, "export const jobs: unknown[] = [];", worker, request, interval],
  "queue is exported through an alias": [server, queue, worker, request, interval, "export { jobs as shared };"],
  "CommonJS export escapes queue": [server, queue, worker, request, interval, "module.exports = { jobs };"],
  "queue reaches an external library": [server, queue, worker, request, interval, "configure(jobs);"],
  "queue alias can escape": [server, queue, worker, request, interval, "const alias = jobs; configure(alias);"],
  "queue method can be overwritten": [server, queue, worker, request, interval, "jobs.push = () => 0;"],
  "queue receives extra unknown mutation": [server, queue, worker, request, interval, "jobs.splice(0);"],
  "queue prototype native method is overwritten": [server, queue, worker, request, interval, "Array.prototype.push = () => 0;"],
  "native array prototype is exposed through qualified access": [server, queue, worker, request, interval, "Object.assign(globalThis.Array['prototype'], overrides);"],
  "timer is shadowed": [server, queue, worker, request, "function setInterval(fn: () => void, delay: number) {}", interval],
  "timer is globally replaced": [server, queue, worker, request, interval, "globalThis.setInterval = fallback;"],
  "drain is only registered conditionally": [server, queue, worker, request, "if (enabled) { " + interval + " }"],
  "timer is reached before its const callback initialization": [
    server, queue, worker, request, "setInterval(drain, 250); const drain = () => work(jobs.shift());",
  ],
  "the drain discards the job": [server, queue, worker, request, "setInterval(() => { jobs.shift(); }, 250);"],
  "unresolved consumer does not establish worker evidence": [server, queue, request, interval],
  "async callback may overlap worker execution": [server, queue, worker, request, "setInterval(async () => work(jobs.shift()), 250);"],
  "async worker may overlap interval ticks": [server, queue, "async function work(job: unknown) { await send(job); }", request, interval],
  "drain loop can remove multiple jobs per tick": [server, queue, worker, request, "setInterval(() => { while (jobs.length) work(jobs.shift()); }, 250);"],
  "function scheduled for drain has a separate caller": [
    server, queue, worker, request, "function drain() { work(jobs.shift()); }",
    "setInterval(drain, 250); drain();",
  ],
  "library queue API is outside the private array pattern": [
    server, "import { Queue } from 'some-queue'; const jobs = new Queue();", worker,
    "createServer(req => jobs.add(req.url));", "setInterval(() => work(jobs.take()), 250);",
  ],
};

for (const [name, source] of Object.entries(negatives)) {
  test(name, async () => assert.deepEqual(await audit({ "server.ts": source.join("\n") }), []));
}

test("same-named queues in different modules never combine", async () => {
  const findings = await audit({
    "producer.ts": [server, queue, request].join("\n"),
    "consumer.ts": ["export {};", queue, worker, interval].join("\n"),
  });
  assert.deepEqual(findings, []);
});

test("cross-file request calls reach a private helper without escaping its buffer", async () => {
  const findings = await audit({
    "server.ts": [server, "import { enqueue } from './queue.js';", "createServer(req => enqueue(req.url));"].join("\n"),
    "queue.ts": [queue, worker, "export function enqueue(job: unknown) { jobs.push(job); }", interval].join("\n"),
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, "queue.ts");
  assert.equal(findings[0].line, 3);
});

test("an unincremented caller counter cannot protect a direct imported helper", async () => {
  const findings = await audit({
    "server.ts": [
      server, "import { enqueue as schedule } from './queue.js';", "let outstanding = 0;",
      "createServer(req => { if (outstanding >= 10) return; schedule(req.url); });",
    ].join("\n"),
    "queue.ts": [queue, worker, "export function enqueue(job: unknown) { jobs.push(job); }", interval].join("\n"),
  });
  assert.equal(findings.length, 1);
});

test("large unrelated source does not trigger repeated per-queue scans", async () => {
  const files = {
    "server.ts": [server, queue, worker, request, interval].join("\n"),
    "helpers.ts": "export {};\n"
      + Array.from({ length: 2_000 }, (_, index) =>
        `const unrelated${index}: unknown[] = []; function other${index}(jobs: unknown[]) { return jobs.length; }`,
      ).join("\n"),
  };
  assert.equal((await audit(files)).length, 1);
});

test("matching native startup cancellation preserves backlog risk with accurate drain evidence", async () => {
  const source = [server, queue, worker, request,
    "const timer = setInterval(() => work(jobs.shift()), 250);", "clearInterval(timer);"].join("\n");
  const [finding] = await audit({ "server.ts": source });
  assert.equal(finding?.id, "unbounded-request-queue");
  assert.match(finding.message, /Startup cancels the interval registered at line 5 \(line 6\)/);
  assert.doesNotMatch(finding.message, /dequeues at most one job/);
});

for (const [name, cancellation] of Object.entries({
  "unrelated timer cancellation": "const other = setInterval(noop, 250); clearInterval(other);",
  "shadowed clearInterval": "function clearInterval(timer: unknown) {} clearInterval(timer);",
  "shutdown-only cancellation": "process.on('SIGTERM', () => clearInterval(timer));",
  "conditional startup cancellation": "if (enabled) clearInterval(timer);",
  "cancellation after startup suspension": "await start(); clearInterval(timer);",
})) {
  test(name + " does not establish pre-tick cancellation", async () => {
    const source = [server, queue, worker, request,
      "const timer = setInterval(() => work(jobs.shift()), 250);", cancellation].join("\n");
    const [finding] = await audit({ "server.ts": source });
    assert.equal(finding?.id, "unbounded-request-queue");
    assert.match(finding.message, /dequeues at most one job/);
  });
}

for (const prefix of ["", "async "]) {
  test(`repeated named timer registrations do not reparse a wrapped ${prefix}drain declaration`, async () => {
    const callback = "(".repeat(250) + prefix + "() => work(jobs.shift())" + ")".repeat(250);
    const repeated = "setInterval(drain, 250);\n".repeat(1_000);
    const source = [queue, worker, "const drain = " + callback + ";", repeated].join("\n");
    assert.deepEqual(await audit({ "server.ts": source }), []);
  });
}
