import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planCodemod, applyPlan } from "../dist/codemod.js";
import { runAudit } from "../dist/runner.js";

function fixture(t, setup = "", options = "") {
  const root = mkdtempSync(join(tmpdir(), "scale-timeout-fix-safety-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = `${setup}\nexport function GET() {\n return fetch('https://example.test'${options});\n}\n`;
  writeFileSync(join(root, "server.ts"), source);
  const finding = { id: "outbound-no-timeout", file: "server.ts", line: source.split("\n").findIndex(line => line.includes("return fetch")) + 1,
    category: "Resilience", severity: "medium", confidence: "medium", snippet: "", message: "", scaleTrigger: "", suggestedFix: "" };
  return { root, source, finding };
}

for (const setup of [
  "globalThis.AbortSignal = custom;", "global.AbortSignal = custom;", "window.AbortSignal = custom;",
  "globalThis['AbortSignal'] = custom;", "AbortSignal.timeout = custom;", "AbortSignal['timeout'] ||= custom;",
  "delete AbortSignal.timeout;", "({timeout: AbortSignal.timeout} = replacement);", "[AbortSignal.timeout] = replacement;",
  "Object.assign(AbortSignal, replacement);", "Object.defineProperty(AbortSignal, 'timeout', descriptor);",
  "Reflect.defineProperty(globalThis, 'AbortSignal', descriptor);", "const signal = AbortSignal; signal.timeout = custom;",
  "const host = globalThis; host.AbortSignal = custom;", "const {AbortSignal: signal} = globalThis; signal.timeout = custom;",
  "function patch() { AbortSignal.timeout = custom; }", "passToUnknown(AbortSignal);",
  "globalThis.globalThis.AbortSignal = custom;", "globalThis['globalThis']['AbortSignal'] = custom;",
  "globalThis.global.AbortSignal = custom;", "window.window.AbortSignal.timeout = custom;",
  "window.parent.AbortSignal.timeout = custom;", "Object.assign(globalThis.globalThis.AbortSignal, replacement);",
  "const host = globalThis.globalThis; host.AbortSignal = custom;",
  "globalThis.__defineGetter__('AbortSignal', () => custom);",
  "globalThis.global.__defineSetter__('AbortSignal', custom);",
]) {
  test(`timeout patches stay manual for altered/escaped native factories: ${setup}`, t => {
    const {root, source, finding} = fixture(t, setup);
    const plan = planCodemod(root, [finding]);
    assert.equal(plan.patched, 0);
    assert.equal(plan.unpatched, 1);
    assert.deepEqual(applyPlan(root, plan), []);
    assert.equal(readFileSync(join(root, "server.ts"), "utf8"), source);
  });
}

for (const setup of [
  "", "globalThis.cache = new Map();", "AbortSignal.timeout(5000);", "globalThis.AbortSignal.timeout(5000);",
  "function configure(AbortSignal) { AbortSignal.timeout = custom; }",
  "function configure(globalThis) { globalThis.AbortSignal = custom; }",
  "const config = { AbortSignal: custom, get globalThis() { return 1; } };",
  "type Signal = AbortSignal; interface Options { signal?: AbortSignal }",
  "globalThis.globalThis.AbortSignal.timeout(5000);", "globalThis.globalThis.cache = new Map();",
]) {
  test(`untouched native timeout insertion remains safe: ${setup || "no setup"}`, t => {
    const {root, finding} = fixture(t, setup);
    const plan = planCodemod(root, [finding]);
    assert.equal(plan.patched, 1);
    assert.equal(plan.files[0].edits[0].safe, true);
    assert.deepEqual(applyPlan(root, plan), ["server.ts"]);
  });
}

for (const options of [
  ", {__proto__: {signal: controller.signal}}", ", {'__proto__': {signal: controller.signal}}",
  ", {__proto__: inheritedOptions, method: 'POST'}", ", {__proto__: {get signal() { return controller.signal; }}}",
]) {
  test(`inherited cancellation cannot be replaced by a safe patch: ${options}`, t => {
    const {root, source, finding} = fixture(t, "const controller = new AbortController();", options);
    const plan = planCodemod(root, [finding]);
    assert.equal(plan.patched, 0);
    assert.deepEqual(applyPlan(root, plan), []);
    assert.equal(readFileSync(join(root, "server.ts"), "utf8"), source);
    const controller = new AbortController();
    const request = new Request("https://example.test", {__proto__: {signal: controller.signal}});
    controller.abort();
    assert.equal(request.signal.aborted, true);
  });
}

test("an analyzed sibling module can invalidate a process-wide timeout factory", async t => {
  const {root} = fixture(t, "import './polyfill';");
  writeFileSync(join(root, "polyfill.ts"), "globalThis.AbortSignal = custom;");
  const report = await runAudit(root, {codemod: "diff"});
  assert.equal(report.complete, true);
  assert.ok(report.findings.some(finding => finding.id === "outbound-no-timeout"));
  assert.equal(report.codemod.patched, 0);
});

test("prototype-based Axios options are also left for review", t => {
  const {root, finding} = fixture(t);
  writeFileSync(join(root, "server.ts"), "import axios from 'axios';\naxios.get(url, {__proto__: {signal: controller.signal}});\n");
  const plan = planCodemod(root, [{...finding, line: 2}]);
  assert.equal(plan.patched, 0);
  assert.deepEqual(applyPlan(root, plan), []);
});
