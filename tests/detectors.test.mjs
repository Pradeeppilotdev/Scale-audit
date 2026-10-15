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

test("unbounded reads flag missing and present pagination correctly", async () => {
  const findings = await detectUnboundedReads(fixture("unbounded"));
  const sites = findings.map((f) => f.line);
  // unboundedDefault() and unboundedWhere() should be flagged; bounded and chained limit should not.
  assert.equal(findings.length, 2, `expected 2 findings, got ${findings.length} at lines ${sites}`);
});

test("missing-index is scoped per model and honors @unique", async () => {
  const findings = await detectMissingIndexes(fixture("missing-index"));
  assert.equal(findings.length, 1);
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

test("sync-io marks request-path high and scripts low", async () => {
  const findings = await detectSyncIo(fixture("sync-io"));
  const route = findings.find((f) => f.file.includes("routes"));
  const script = findings.find((f) => f.file.includes("scripts"));
  assert.ok(route, "expected route sync finding");
  assert.ok(script, "expected script sync finding");
  assert.equal(route.severity, "high");
  assert.equal(script.severity, "low");
});

test("outbound timeouts flag fetch/axios without timeout only", async () => {
  const findings = await detectOutboundTimeouts(fixture("outbound-timeout"));
  assert.equal(findings.length, 2, JSON.stringify(findings.map((f) => f.snippet)));
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
