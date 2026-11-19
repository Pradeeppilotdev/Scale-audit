import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { AnalysisBudget, AnalysisLimitError } from "../dist/analysisBudget.js";
import { requestEvidence } from "../dist/requestEvidence.js";
import { Workspace } from "../dist/workspace.js";

async function withWorkspace(source, run) {
  const root = await mkdtemp(join(tmpdir(), "scale-request-evidence-budget-"));
  try {
    await writeFile(join(root, "server.ts"), source);
    return await run(await Workspace.load(root));
  } finally { await rm(root, { recursive: true, force: true }); }
}

function calls(workspace, name) {
  const result = [];
  const pending = workspace.units.map(unit => unit.sf);
  while (pending.length) {
    const node = pending.pop();
    if (ts.isCallExpression(node) && node.expression.getText() === name) result.push(node);
    ts.forEachChild(node, child => { pending.push(child); });
  }
  return result;
}

test("request evidence charges traversal and shares deeply nested owner lookup", async () => {
  const work = [];
  for (const depth of [100, 200]) {
    const source = `import { createServer } from 'node:http'; function read() {}
      createServer(() => {${"{".repeat(depth)}${"read();".repeat(depth * 4)}${"}".repeat(depth)}});`;
    await withWorkspace(source, workspace => {
      const take = AnalysisBudget.prototype.take;
      let charged = 0;
      AnalysisBudget.prototype.take = function (count = 1) {
        if (this.label === "Request evidence") charged += count;
        return take.call(this, count);
      };
      try {
        const evidence = requestEvidence(workspace);
        assert.ok(calls(workspace, "read").every(evidence));
        work.push(charged);
        assert.ok(charged > depth * 8, "the AST and owner walk must be accounted for");
      } finally { AnalysisBudget.prototype.take = take; }
    });
  }
  assert.ok(work[1] < work[0] * 2.2, `owner lookup should grow linearly: ${work}`);
});

test("request evidence memoizes completed builds and owner queries without leaking lexical reachability", async () => {
  await withWorkspace(`import { createServer } from 'node:http';
    function helper() { readFileSync('reachable'); }
    function unrelated() { readFileSync('private'); }
    createServer(() => { helper(); function nested() { readFileSync('uninvoked'); } });`, workspace => {
    const take = AnalysisBudget.prototype.take;
    let charged = 0;
    AnalysisBudget.prototype.take = function (count = 1) {
      if (this.label === "Request evidence") charged += count;
      return take.call(this, count);
    };
    try {
      const evidence = requestEvidence(workspace);
      const reads = calls(workspace, "readFileSync");
      for (const call of reads) assert.equal(evidence(call), call.arguments[0].text === "reachable");
      const settled = charged;
      for (let iteration = 0; iteration < 100; iteration++) {
        assert.equal(requestEvidence(workspace), evidence);
        for (const call of reads) evidence(call);
      }
      assert.equal(charged, settled, "cached lookups must not repeat ancestor walks");
    } finally { AnalysisBudget.prototype.take = take; }
  });
});

test("request evidence rethrows a failed build without restarting the exhausted traversal", async () => {
  await withWorkspace("export function GET() { return helper(); } function helper() {}", workspace => {
    const take = AnalysisBudget.prototype.take;
    const exhausted = new AnalysisLimitError("Request evidence analysis work budget exceeded");
    let attempts = 0;
    AnalysisBudget.prototype.take = function (count = 1) {
      if (this.label === "Request evidence" && ++attempts === 5) throw exhausted;
      return take.call(this, count);
    };
    try {
      assert.throws(() => requestEvidence(workspace), error => error === exhausted);
      assert.throws(() => requestEvidence(workspace), error => error === exhausted);
      assert.equal(attempts, 5);
    } finally { AnalysisBudget.prototype.take = take; }
  });
});
