import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createAuditServer } from "../dist/server.js";

const repo = "https://github.com/owner/repo";
const fixture = fileURLToPath(new URL("./fixtures/badapp", import.meta.url));

function harness(t, options = {}) {
  const app = createAuditServer(options);
  t.after(() => app.close());
  async function request(url = "/api/audit", settings = {}) {
    const req = new PassThrough();
    req.method = settings.method ?? "POST";
    req.url = url;
    req.headers = { host: "localhost:8787", "content-type": "application/json", ...settings.headers };
    req.socket = { remoteAddress: settings.ip ?? "127.0.0.1" };
    const headers = {};
    const res = {
      setHeader(name, value) { headers[name] = value; },
      writeHead(status, values) { this.status = status; Object.assign(headers, values); },
      end(body) { this.body = body; },
    };
    const handled = app.handler(req, res);
    for (const chunk of settings.chunks ?? [settings.body ?? JSON.stringify({ repo })]) req.write(chunk);
    req.end();
    await handled;
    return { status: res.status, headers, text: res.body, json: () => JSON.parse(res.body), req };
  }
  const get = (url) => request(url, { method: "GET" });
  return { ...app, request, get };
}

async function finished(app, id) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await app.get(`/api/jobs/${id}`);
    const job = response.json();
    if (job.status === "done" || job.status === "error") return job;
    await delay(10);
  }
  assert.fail("audit did not finish");
}

test("rejects local paths, foreign repositories, and malformed JSON objects", async (t) => {
  const app = harness(t, { audit: async () => assert.fail("must not audit") });
  for (const value of [fixture, "/etc", "https://evil.example/owner/repo", "https://github.com.evil/owner/repo"]) {
    assert.equal((await app.request(undefined, { body: JSON.stringify({ repo: value }) })).status, 400);
  }
  for (const body of ["null", "[]", "{}", "{", '{"repo":42}']) {
    assert.equal((await app.request(undefined, { body })).status, 400);
  }
});

test("body limit counts streamed bytes without destroying the request before 413", async (t) => {
  const app = harness(t, { audit: async () => assert.fail("must not audit") });
  for (const chunks of [[Buffer.alloc(10_001, 32)], [Buffer.alloc(9999, 32), Buffer.from("é")]]) {
    const response = await app.request(undefined, { chunks });
    assert.equal(response.status, 413);
    assert.equal(response.req.destroyed, false);
    assert.equal(response.headers.connection, "close");
  }
  assert.equal((await app.request(undefined, { headers: { "content-length": "10001" }, body: "" })).status, 413);
  const valid = JSON.stringify({ repo });
  const boundary = valid + " ".repeat(10_000 - Buffer.byteLength(valid));
  const accepted = harness(t, { audit: async () => ({}) });
  assert.equal((await accepted.request(undefined, { body: boundary })).status, 202);
});

test("requires application/json and rejects foreign Host/Origin independently", async (t) => {
  const app = harness(t, { audit: async () => ({}) });
  for (const type of [undefined, "text/plain", "application/jsonp", "application/x-www-form-urlencoded"]) {
    assert.equal((await app.request(undefined, { headers: { "content-type": type } })).status, 415);
  }
  for (const headers of [
    { origin: "https://evil.example" },
    { origin: "null" },
    { origin: "http://localhost:8788" },
    { origin: "https://localhost:8787" },
    { host: "evil.example:8787", origin: "http://evil.example:8787" },
    { host: "localhost:8788" },
    { host: "localhost:8787@evil.example" },
    { host: undefined },
  ]) {
    assert.equal((await app.request(undefined, { headers })).status, 403);
  }
  assert.equal((await app.request(undefined, {
    headers: { host: "127.0.0.1:8787", origin: "http://localhost:8787", "content-type": "Application/JSON; charset=utf-8" },
  })).status, 202);
});

test("validates concurrency and resource limits instead of silently stalling", () => {
  for (const concurrency of [0, -1, NaN, Infinity, 1.5, "", "2junk", 33]) {
    assert.throws(() => createAuditServer({ concurrency }), /concurrency/);
  }
  for (const option of ["maxJobs", "reportTtlMs", "maxReportBytes", "timeoutMs", "memoryMb"]) {
    assert.throws(() => createAuditServer({ [option]: 0 }));
  }
});

test("hard global cap applies before enqueue, independent of IP, and preserves concurrency", async (t) => {
  let complete;
  let calls = 0;
  const waiting = new Promise((resolve) => { complete = resolve; });
  const app = harness(t, { maxJobs: 2, concurrency: 1, audit: async () => { calls++; await waiting; return {}; } });
  const first = await app.request();
  const second = await app.request(undefined, { ip: "client-two" });
  assert.equal(first.status, 202);
  assert.equal(second.json().status, "queued");
  assert.equal((await app.request(undefined, { ip: "client-three" })).status, 503);
  assert.equal((await app.get("/health")).json().jobs, 2);
  assert.equal(calls, 1);
  complete();
  assert.equal((await finished(app, second.json().id)).status, "done");
  assert.equal(calls, 2);
  // Completed reports still consume retention capacity until expiry.
  assert.equal((await app.request(undefined, { ip: "client-four" })).status, 503);
});

test("simultaneous body reads cannot race past capacity", async (t) => {
  const app = harness(t, { maxJobs: 1, audit: async () => ({}) });
  const responses = await Promise.all([app.request(), app.request()]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [202, 503]);
});

test("reports are byte-capped, expire, and are never cacheable", async (t) => {
  let clock = 1000;
  const app = harness(t, { maxJobs: 1, maxReportBytes: 100, reportTtlMs: 50, now: () => clock,
    audit: async () => ({ notes: ["é".repeat(60)] }),
  });
  const created = await app.request();
  const id = created.json().id;
  const job = await finished(app, id);
  assert.equal(job.status, "error");
  assert.match(job.error, /byte limit/);
  assert.equal(job.report, undefined);
  const status = await app.get(`/api/jobs/${id}`);
  assert.equal(status.headers["cache-control"], "no-store");
  assert.equal((await app.get(`/report/${id}`)).status, 404);
  clock += 50;
  assert.equal((await app.get(`/api/jobs/${id}`)).status, 404);
  assert.equal((await app.request()).status, 202);
});

test("successful retained reports also expire", async (t) => {
  let clock = 1000;
  const app = harness(t, { now: () => clock, reportTtlMs: 50, audit: async () => ({}) });
  const id = (await app.request()).json().id;
  assert.equal((await finished(app, id)).status, "done");
  clock += 50;
  assert.equal((await app.get(`/api/jobs/${id}`)).status, 404);
  assert.equal((await app.get(`/report/${id}`)).status, 404);
});

test("local fixture audit executes in a child and serves a no-store HTML report without binding", async (t) => {
  const app = harness(t, { allowLocal: true });
  const response = await app.request(undefined, { body: JSON.stringify({ repo: fixture }) });
  assert.equal(response.status, 202);
  const id = response.json().id;
  const job = await finished(app, id);
  assert.equal(job.status, "done", job.error);
  const html = await app.get(`/report/${id}`);
  assert.equal(html.status, 200);
  assert.match(html.text, /Scale-Readiness Report/);
  assert.equal(html.headers["cache-control"], "no-store");
});

test("rendered HTML has its own byte cap after escaping", async (t) => {
  const app = harness(t, { maxReportBytes: 10_000, audit: async () => ({
    repo, scannedAt: "now", score: 100, findings: [],
    fingerprint: { sourceFileCount: 0, projectType: "unknown" },
    notes: ["<".repeat(8000)],
  }) });
  const id = (await app.request()).json().id;
  assert.equal((await finished(app, id)).status, "done");
  const html = await app.get(`/report/${id}`);
  assert.equal(html.status, 413);
  assert.equal(html.headers["cache-control"], "no-store");
});

test("origin checks follow the actual listening port, including an ephemeral port", async (t) => {
  const app = harness(t, { port: 0, audit: async () => ({}) });
  app.server.address = () => ({ address: "127.0.0.1", family: "IPv4", port: 12345 });
  assert.equal((await app.request()).status, 403);
  assert.equal((await app.request(undefined, {
    headers: { host: "localhost:12345", origin: "http://127.0.0.1:12345" },
  })).status, 202);
  assert.equal((await app.request(undefined, {
    headers: { host: "localhost:12345", origin: "http://localhost:8787" },
  })).status, 403);
});

test("SSH-style input is converted to credential-free HTTPS and local relative paths remain usable", async (t) => {
  const seen = [];
  const app = harness(t, { allowLocal: true, audit: async (input) => { seen.push(input); return {}; } });
  const ssh = (await app.request(undefined, { body: JSON.stringify({ repo: "git@github.com:owner/repo.git" }) })).json();
  await finished(app, ssh.id);
  const local = (await app.request(undefined, { body: JSON.stringify({ repo: "./tests/fixtures/badapp" }) })).json();
  await finished(app, local.id);
  assert.deepEqual(seen, ["https://github.com/owner/repo.git", fixture]);
});

test("rate limiting still rejects a client's eleventh submission", async (t) => {
  const app = harness(t, { audit: async () => ({}) });
  for (let i = 0; i < 10; i++) assert.equal((await app.request(undefined, { body: "{}" })).status, 400);
  assert.equal((await app.request()).status, 429);
});

test("shutdown rejects new work", async (t) => {
  const app = harness(t, { audit: async () => ({}) });
  await app.close();
  assert.equal((await app.request()).status, 503);
});
