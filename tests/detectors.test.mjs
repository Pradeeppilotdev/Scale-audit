import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = (name) => path.join(root, "tests", "fixtures", "detectors", name);

const { detectNPlusOne } = await import(path.join(root, "dist", "detectors", "n1.js"));
const { detectUnboundedReads } = await import(path.join(root, "dist", "detectors", "unbounded.js"));
const { detectMissingIndexes } = await import(path.join(root, "dist", "detectors", "missingIndex.js"));
const { detectInProcessState } = await import(path.join(root, "dist", "detectors", "inProcessState.js"));
const { detectSyncIo } = await import(path.join(root, "dist", "detectors", "syncIo.js"));
const { detectOutboundTimeouts } = await import(path.join(root, "dist", "detectors", "outboundTimeout.js"));
const { detectUnboundedConcurrency } = await import(path.join(root, "dist", "detectors", "unboundedConcurrency.js"));
const { detectLifecycle } = await import(path.join(root, "dist", "detectors", "lifecycle.js"));

test("n-plus-one flags awaited ORM call inside a loop", async () => {
  const findings = await detectNPlusOne(fixture("n1"));
  assert.equal(findings.filter((f) => f.id === "n-plus-one").length, 1);
});

test("unbounded reads: flags real gaps, ignores array helpers and options-object limits", async () => {
  const findings = await detectUnboundedReads(fixture("unbounded"));
  const sites = findings.map((f) => `${f.line}:${f.confidence}`);
  // unboundedDefault, unboundedWhere (high) + variableQuery (low confidence).
  // chained limit, mongoose 3rd-arg options, and array .find must NOT be flagged.
  assert.equal(findings.length, 3, `expected 3 findings, got ${findings.length} at ${sites.join(", ")}`);
  const low = findings.filter((f) => f.confidence === "low");
  assert.equal(low.length, 1, "variable query must be low confidence");
  assert.match(low[0].message, /could not be confirmed/);
});

test("missing-index is scoped per model and honors @unique", async () => {
  const findings = await detectMissingIndexes(fixture("missing-index"));
  assert.equal(findings.length, 1, JSON.stringify(findings.map((f) => f.message)));
  assert.match(findings[0].message, /"name"/);
});

test("in-process state flags session/rate-limit only when store is absent", async () => {
  const findings = await detectInProcessState(fixture("in-process-state"));
  const ids = findings.map((f) => f.id);
  assert.equal(ids.filter((id) => id === "in-process-session").length, 1);
  assert.equal(ids.filter((id) => id === "in-memory-rate-limit").length, 1);
  assert.equal(ids.filter((id) => id === "in-process-state").length, 1);
  assert.equal(ids.filter((id) => id === "in-memory-websocket").length, 1);
});

test("sync-io marks request-path high, scripts and startup low", async () => {
  const findings = await detectSyncIo(fixture("sync-io"));
  const route = findings.find((f) => f.file.includes("routes"));
  const script = findings.find((f) => f.file.includes("scripts"));
  const startup = findings.find((f) => f.file.endsWith("config.ts"));
  assert.ok(route, "expected route sync finding");
  assert.ok(script, "expected script sync finding");
  assert.ok(startup, "expected module-scope sync finding");
  assert.equal(route.severity, "high");
  assert.equal(script.severity, "low");
  assert.equal(startup.severity, "low");
  assert.match(startup.message, /module scope/);
});

test("outbound timeouts: real timers bounded, cancellation-only and variables downgraded", async () => {
  const findings = await detectOutboundTimeouts(fixture("outbound-timeout"));
  const files = findings.map((f) => `${f.file}:${f.line}:${f.severity}/${f.confidence}`);
  assert.equal(findings.length, 4, JSON.stringify(files));
  assert.ok(!findings.some((f) => f.file.includes("shared")), "shared axios client must be honored");
  assert.ok(!findings.some((f) => f.snippet.includes("anyTimeout")), "AbortSignal.any with timeout must be bounded");
  assert.ok(!findings.some((f) => f.snippet.includes("withTimeoutFetch")), "AbortSignal.timeout must be bounded");

  const low = findings.filter((f) => f.confidence === "low");
  assert.equal(low.length, 2, JSON.stringify(files));
  assert.ok(low.some((f) => /cancellation signal but no timeout/.test(f.message)), "expected cancellation-only finding");
  assert.ok(low.some((f) => /could not confirm/.test(f.message)), "expected variable-config finding");

  const medium = findings.filter((f) => f.severity === "medium");
  assert.equal(medium.length, 2, "inline configs without any signal must stay medium");
});

test("unbounded concurrency flags Promise.all over unbounded maps", async () => {
  const findings = await detectUnboundedConcurrency(fixture("unbounded-concurrency"));
  assert.equal(findings.length, 2, JSON.stringify(findings.map((f) => f.snippet)));
});

test("lifecycle detects missing health endpoint and graceful shutdown", async () => {
  const findings = await detectLifecycle(fixture("lifecycle"));
  const ids = findings.map((f) => f.id);
  assert.ok(ids.includes("missing-health-endpoint"));
  assert.ok(ids.includes("missing-graceful-shutdown"));
});
