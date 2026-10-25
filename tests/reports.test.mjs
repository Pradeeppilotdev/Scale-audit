import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHtml } from "../dist/reportHtml.js";
import { renderMarkdown } from "../dist/reportMarkdown.js";

function report() {
  return {
    repo: "fixture", commit: null, scannedAt: "now", score: 100, findings: [], notes: [], firstBottleneck: null,
    fingerprint: { framework: null, orm: null, projectType: "unknown", sourceFileCount: 0, fileCount: 0, deps: {}, devDeps: {}, hasTests: true, hasCI: true },
    codemod: {
      patched: 1, unpatched: 1, applied: false, appliedEdits: 0, files: [], diff: "",
      edits: [{ findingId: "unbounded-read", file: "src/app.js", line: 1, description: "pagination truncates results", safe: false }],
      manual: [{ findingId: "floating-promise", file: "src/<script>.js", line: 2, description: "repair <manually>", safe: false }],
    },
  };
}

test("HTML and Markdown distinguish suggestions, review requirements and actual applications", () => {
  const value = report();
  const html = renderHtml(value);
  assert.match(html, /Fix suggestions/);
  assert.match(html, /1 generated; 0 edits applied/);
  assert.match(html, /Review required; never auto-applied/);
  assert.match(html, /Manual fixes/);
  assert.match(html, /src\/&lt;script&gt;\.js/);
  assert.match(html, /repair &lt;manually&gt;/);
  assert.doesNotMatch(html, /src\/<script>/);
  const markdown = renderMarkdown(value);
  assert.match(markdown, /1 suggestion\(s\) generated; 0 edit\(s\) applied/);
  assert.match(markdown, /review required; never auto-applied/);
  assert.match(markdown, /Manual:.*src\/<script>\.js:2/);
});

test("reports still render older summaries without the new accounting fields", () => {
  const value = report();
  delete value.codemod.manual;
  delete value.codemod.appliedEdits;
  assert.match(renderHtml(value), /0 edits applied/);
  assert.match(renderMarkdown(value), /0 edit\(s\) applied/);
});
