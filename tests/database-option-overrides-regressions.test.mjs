import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectUnboundedReads } from "../dist/detectors/unbounded.js";
import { detectMissingIndexes } from "../dist/detectors/missingIndex.js";
import { AnalysisBudget, AnalysisLimitError } from "../dist/analysisBudget.js";
import { runAudit } from "../dist/runner.js";

async function audit(source, detector) {
  const root = await mkdtemp(join(tmpdir(), "scale-effective-db-options-"));
  try {
    await writeFile(join(root, "server.js"), source);
    await writeFile(join(root, "schema.prisma"), "model User {\n id Int @id\n email String\n}\n");
    return await detector(root);
  } finally { await rm(root, {recursive: true, force: true}); }
}

for (const key of ["take", "limit", "top", "first", "pageSize", "perPage"]) {
  for (const member of [`get ${key}() { return undefined; }`, `set ${key}(value) {}`, `${key}() { return 10; }`]) {
    test(`a later ${member} invalidates a numeric pagination cap`, async () => {
      const findings = await audit(`prisma.user.findMany({${key}:10,${member}});`, detectUnboundedReads);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].confidence, "low");
      assert.deepEqual(await audit(`prisma.user.findMany({${member},${key}:10});`, detectUnboundedReads), []);
    });
  }
}

for (const [where, expected] of [
  ["{email:input}", 1], ["{id:1}", 0],
  ["{email:input,email:undefined}", 0], ["{email:undefined,email:input}", 1],
  ["{email:input,...{email:undefined}}", 0], ["{email:undefined,...{email:input}}", 1],
  ["{email:input,...options}", 0], ["{...options,email:input}", 1],
  ["{email:input,...{...options}}", 0], ["{email:input,...{...options,email:input}}", 1],
  ["{email:input,get email(){return undefined;}}", 0], ["{get email(){return undefined;},email:input}", 1],
  ["{email:input,...{get email(){return undefined;}}}", 0],
  ["{email:input,[key]:value}", 0], ["{[key]:value,email:input}", 1],
]) {
  test(`missing-index evidence follows effective filter properties: ${where}`, async () => {
    assert.equal((await audit(`prisma.user.findMany({where:${where}});`, detectMissingIndexes)).length, expected);
  });
}

for (const operator of ["OR", "AND", "NOT"]) {
  for (const [first, last, expected] of [["email:input", "id:1", 0], ["id:1", "email:input", 1]]) {
    for (const array of [true, false]) {
      const group = field => array ? `[{${field}}]` : `{${field}}`;
      test(`${operator} filter replacement discards earlier nested fields (${array ? "array" : "object"})`, async () => {
        const source = `prisma.user.findMany({where:{${operator}:${group(first)},...{${operator}:${group(last)}}}});`;
        assert.equal((await audit(source, detectMissingIndexes)).length, expected);
      });
    }
  }
}

test("a literal spread can replace the entire where option", async () => {
  assert.deepEqual(await audit("prisma.user.findMany({where:{email:input},...{where:{id:1}}});", detectMissingIndexes), []);
  assert.equal((await audit("prisma.user.findMany({where:{id:1},...{where:{email:input}}});", detectMissingIndexes)).length, 1);
});

for (const [filter, expected] of [
  ["{equals:input}", 1], ["{equals:undefined}", 0], ["{equals:null}", 1],
  ["{equals:input,equals:undefined}", 0], ["{equals:undefined,equals:input}", 1],
  ["{...{equals:input}}", 1], ["{...{...{equals:input}}}", 1],
  ["{equals:input,...{equals:undefined}}", 0], ["{equals:undefined,...{equals:input}}", 1],
  ["{equals:input,...options}", 0], ["{...options,equals:input}", 1],
  ["{equals:input,...{...options}}", 0], ["{equals:input,...{...options,equals:input}}", 1],
  ["{equals:input,get equals(){return undefined;}}", 0], ["{get equals(){return undefined;},equals:input}", 1],
  ["{equals:input,...{get equals(){return input;}}}", 0],
  ["{equals:input,set equals(value){}}", 0], ["{equals:input,equals(){return input;}}", 0],
  ["{equals:input,[key]:value}", 0], ["{[key]:value,equals:input}", 1],
  ["{equals:undefined,contains:input}", 1], ["{equals:input,contains:undefined}", 1],
  ["{equals:undefined,contains:undefined}", 0], ["{mode:'insensitive'}", 0],
]) {
  test(`scalar filter operators use their effective own values: ${filter}`, async () => {
    assert.equal((await audit(`prisma.user.findMany({where:{email:${filter}}});`, detectMissingIndexes)).length, expected);
  });
}

for (const filter of ["undefined", "{equals:undefined}", "{...{equals:undefined}}"]) {
  test(`a local undefined binding remains a filter value: ${filter}`, async () => {
    assert.equal((await audit(`function query(undefined){return prisma.user.findMany({where:{email:${filter}}});}`, detectMissingIndexes)).length, 1);
    assert.deepEqual(await audit(`prisma.user.findMany({where:{email:${filter}}});`, detectMissingIndexes), []);
  });
}

test("scalar filter literal spreads retain the existing recursion limit", async () => {
  for (const count of [64, 65]) {
    let filter = "{equals:input}";
    for (let index = 0; index < count; index++) filter = `{...${filter}}`;
    if (count === 64) assert.equal((await audit(`prisma.user.findMany({where:{email:${filter}}});`, detectMissingIndexes)).length, 1);
    else await assert.rejects(() => audit(`prisma.user.findMany({where:{email:${filter}}});`, detectMissingIndexes), error =>
      error instanceof AnalysisLimitError && /Database filter recursion limit exceeded/.test(error.message));
  }
});

test("scalar filter work-limit failures propagate into incomplete audits", async () => {
  const take = AnalysisBudget.prototype.take;
  let charged = 0;
  AnalysisBudget.prototype.take = function(units = 1) {
    if (this.label === "Database filters" && (charged += units) > 12) throw new AnalysisLimitError("Database filters analysis work budget exceeded");
    return take.call(this, units);
  };
  try {
    const report = await audit("prisma.user.findMany({where:{email:{...{...{equals:input}}}}});", runAudit);
    assert.equal(report.complete, false);
    assert.equal(report.detectors.find(detector => detector.name === "detectMissingIndexes").status, "failed");
    assert.ok(charged > 12);
  } finally { AnalysisBudget.prototype.take = take; }
});

test("database filter work grows with inspected fields and is charged", async () => {
  const observed = [];
  for (const count of [500, 1000]) {
    const source = `prisma.user.findMany({where:{OR:[${Array.from({length: count}, () => "{email:input,...{email:undefined,id:1}}").join(",")}]}});`;
    const take = AnalysisBudget.prototype.take;
    let charged = 0;
    AnalysisBudget.prototype.take = function(units = 1) {
      if (this.label === "Database filters") charged += units;
      return take.call(this, units);
    };
    try { assert.deepEqual(await audit(source, detectMissingIndexes), []); }
    finally { AnalysisBudget.prototype.take = take; }
    observed.push(charged);
  }
  assert.ok(observed[0] > 500);
  assert.ok(observed[1] < observed[0] * 2.1, String(observed));
});

test("filter budget exhaustion is a strict incomplete audit", async () => {
  const take = AnalysisBudget.prototype.take;
  AnalysisBudget.prototype.take = function(units = 1) {
    if (this.label === "Database filters") throw new AnalysisLimitError("Database filters analysis work budget exceeded");
    return take.call(this, units);
  };
  try {
    const report = await audit("prisma.user.findMany({where:{email:input}});", runAudit);
    assert.equal(report.complete, false);
    assert.equal(report.detectors.find(detector => detector.name === "detectMissingIndexes").status, "failed");
  } finally { AnalysisBudget.prototype.take = take; }
});
