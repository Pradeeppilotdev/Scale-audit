import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import { AnalysisBudget } from "../dist/analysisBudget.js";
import { conditionTruth } from "../dist/conditionTruth.js";

function expression(source) {
  const file = ts.createSourceFile("guard.ts", `(${source});`, ts.ScriptTarget.Latest, true);
  assert.equal(file.parseDiagnostics.length, 0, source);
  return file.statements[0].expression;
}

// Only these fixed test expressions are executed, never audited source files.
const atoms = ["x", "y", "true", "false", "null", "0", "1", "''", "'yes'"];
const inputs = [undefined, null, false, true, 0, 1, NaN, "", "yes", 0n, 1n, {}, []];

function compareWithJavaScript(sources, t) {
  let folded = 0, comparisons = 0;
  for (const source of sources) {
    const node = expression(source);
    const budget = new AnalysisBudget("Condition truth oracle");
    const observed = conditionTruth(node, budget);
    assert.equal(conditionTruth(node, budget), observed, `cached result: ${source}`);
    assert.equal(conditionTruth(node, new AnalysisBudget("Independent truth oracle")), observed,
      `independent audit: ${source}`);
    if (observed === undefined) continue;
    folded++;
    const evaluate = new Function("x", "y", `"use strict"; return (${source});`);
    for (const x of inputs) for (const y of inputs) {
      assert.equal(Boolean(evaluate(x, y)), observed, source);
      comparisons++;
    }
  }
  assert.ok(folded > 0, "the matrix must exercise known results as well as unknown ones");
  t.diagnostic(`${folded} constant results matched JavaScript in ${comparisons} input combinations`);
}

test("logical and strict Boolean conclusions match JavaScript across value types", t => {
  const sources = new Set();
  for (const left of atoms) for (const right of atoms) for (const operator of ["&&", "||"]) {
    const value = `(${left} ${operator} ${right})`;
    for (const result of [value, `!${value}`, `${value} === true`, `${value} !== false`,
      `false === ${value}`, `true !== ${value}`, `(${value} === true) || false`]) sources.add(result);
  }
  compareWithJavaScript(sources, t);
});

test("ternary and nullish conclusions match JavaScript across value types", t => {
  const sources = new Set();
  for (const yes of atoms) for (const no of atoms) {
    const ternary = `(x ? ${yes} : ${no})`;
    for (const value of [ternary, `(${ternary} ?? false)`, `(${ternary} ?? true)`]) {
      for (const result of [value, `!${value}`, `${value} === true`, `${value} === false`, `${value} !== true`]) {
        sources.add(result);
      }
    }
  }
  compareWithJavaScript(sources, t);
});

test("constant and input-dependent Boolean results stay distinct", () => {
  for (const [source, expected] of [
    ["(x ? true : true) === true", true],
    ["(null ?? false) === false", true],
    ["(0 ?? false) === false", false],
    ["(x ? 0 : true) === true", undefined],
    ["(x ?? false) === false", undefined],
    ["(x || true) === true", undefined],
  ]) {
    assert.equal(conditionTruth(expression(source), new AnalysisBudget("Boolean result")), expected, source);
  }
});
