import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planCodemod, applyPlan } from "../dist/codemod.js";

function finding(line) {
  return { id: "outbound-no-timeout", file: "app.js", line, category: "Resilience", severity: "high",
    confidence: "high", snippet: "", message: "missing timeout", scaleTrigger: "", suggestedFix: "" };
}

test("many timeout suggestions retain original offsets, ambiguity checks, and duplicate handling", t => {
  const root = mkdtempSync(join(tmpdir(), "scale-codemod-many-sites-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rows = Array.from({ length: 2000 }, (_, index) => `fetch("https://example.test/${index}");`);
  rows.push('fetch("https://example.test/a"); fetch("https://example.test/b");');
  const source = rows.join("\n") + "\n";
  writeFileSync(join(root, "app.js"), source);
  const findings = rows.map((_, index) => finding(index + 1)).reverse();
  findings.push(finding(1000));
  const plan = planCodemod(root, findings);
  assert.equal(plan.patched, 2000);
  assert.equal(plan.unpatched, 2);
  assert.equal(plan.manual.length, 2);
  const expected = rows.map((row, index) => index < 2000
    ? row.replace(");", ", { signal: AbortSignal.timeout(5000) });") : row).join("\n") + "\n";
  assert.equal(plan.files[0].after, expected);
  assert.equal(readFileSync(join(root, "app.js"), "utf8"), source);
  assert.deepEqual(applyPlan(root, plan), ["app.js"]);
  assert.equal(readFileSync(join(root, "app.js"), "utf8"), expected);
});

for (const source of [
  'function request(AbortSignal) {\nfetch("https://example.test");\n}',
  'function request() {\nfetch("https://example.test");\nconst AbortSignal = custom;\n}',
  'import { AbortSignal } from "custom";\nfetch("https://example.test");',
]) {
  test(`timeout insertion still refuses a shadowed AbortSignal: ${source.split("\n")[0]}`, t => {
    const root = mkdtempSync(join(tmpdir(), "scale-codemod-shadow-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "app.js"), source);
    const plan = planCodemod(root, [finding(2)]);
    assert.equal(plan.patched, 0);
    assert.equal(plan.unpatched, 1);
    assert.deepEqual(applyPlan(root, plan), []);
    assert.equal(readFileSync(join(root, "app.js"), "utf8"), source);
  });
}
