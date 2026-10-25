import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createAuditProcessRunner, auditEnvironment } from "../dist/auditProcess.js";

const fixture = fileURLToPath(new URL("./fixtures/badapp", import.meta.url));

test("audit environment does not inherit credentials, Git configuration, or test setup", () => {
  const env = auditEnvironment("/isolated/job");
  for (const name of ["NODE_OPTIONS", "NODE_TEST_CONTEXT", "GITHUB_TOKEN", "GH_TOKEN", "SSH_AUTH_SOCK", "GIT_SSH_COMMAND", "GIT_ASKPASS", "HTTPS_PROXY"]) {
    assert.equal(env[name], undefined, name);
  }
  assert.equal(env.HOME, "/isolated/job");
  assert.equal(env.TMPDIR, "/isolated/job");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  const configs = Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
  assert.equal(configs["credential.helper"], "");
  assert.equal(configs["protocol.allow"], "never");
  assert.equal(configs["protocol.https.allow"], "always");
  assert.equal(configs["http.followRedirects"], "false");
});

test("child runs local audit without inheriting NODE_OPTIONS mock/import hooks", async () => {
  const old = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--import=file:///nonexistent-test-mock.mjs";
  const runner = createAuditProcessRunner();
  try {
    const report = await runner.audit(fixture);
    assert.equal(report.repo, fixture);
    assert.ok(report.findings.length > 0);
  } finally {
    runner.close();
    if (old === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = old;
  }
});

test("child timeout kills the audit and permits a clean runner shutdown", async () => {
  const runner = createAuditProcessRunner({ timeoutMs: 1 });
  try {
    await assert.rejects(runner.audit(fixture), /timed out/);
  } finally {
    runner.close();
  }
});

test("child serialization is capped before the parent retains a report", async () => {
  const runner = createAuditProcessRunner({ maxReportBytes: 100 });
  try {
    await assert.rejects(runner.audit(fixture), /byte limit/);
  } finally {
    runner.close();
  }
});

test("shutdown cancels active children and refuses subsequent work", async () => {
  const runner = createAuditProcessRunner();
  const running = runner.audit(fixture);
  // The async temp-directory creation may still be in flight; either path must cancel.
  runner.close();
  await assert.rejects(running, /closed|cancelled/);
  await assert.rejects(runner.audit(fixture), /closed/);
});
