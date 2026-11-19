import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { AnalysisBudget, projectWorkLimit } from "../dist/analysisBudget.js";
import { currentImportedBinding } from "../dist/bindings.js";
import { sourceSnippetAt } from "../dist/detectors/common.js";
import { providerLifetimes } from "../dist/lifetimes.js";
import { runAudit } from "../dist/runner.js";
import { Workspace } from "../dist/workspace.js";

async function fixture(t, source) {
  const root = await mkdtemp(join(tmpdir(), "scale-shared-work-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "model.ts"), source);
  return root;
}

function countWork(label, operation) {
  const original = AnalysisBudget.prototype.take;
  let work = 0;
  AnalysisBudget.prototype.take = function (count = 1) {
    if (this.label === label) work += count;
    return original.call(this, count);
  };
  try { return { value: operation(), work }; }
  finally { AnalysisBudget.prototype.take = original; }
}

test("wide computed namespace writes share their order checks across distinct method names", async t => {
  const work = [];
  for (const count of [100, 200, 400]) {
    const writes = Array.from({ length: count }, (_, i) => `db[columns[${i}]] = configure;`);
    const calls = Array.from({ length: count }, (_, i) => `db.method${i}();`);
    const root = await fixture(t, ["import db from 'generated-api';", ...writes, "export function GET(){", ...calls, "}"].join("\n"));
    const { units: [{ sf }] } = await Workspace.load(root);
    const queries = sf.statements.at(-1).body.statements.map(statement => statement.expression.expression);
    const measured = countWork("Promise binding writes", () => queries.map(query => currentImportedBinding(query)));
    assert.ok(measured.value.every(result => result === null), "a computed write cannot establish any specific method");
    assert.ok(measured.work >= count && measured.work < projectWorkLimit([sf]));
    work.push(measured.work);
    if (count === 400) {
      const report = await runAudit(root);
      assert.equal(report.complete, true, JSON.stringify(report.detectors));
    }
  }
  assert.ok(work[1] < work[0] * 2.4 && work[2] < work[1] * 2.4, String(work));
});

test("a wildcard write never proves a named replacement, and a later exact write restores identity", async t => {
  const root = await fixture(t, `import api from "axios";
    const nativePost = api.post;
    api["*"] = nativePost;
    const beforeWildcard = api.get;
    api[key] = nativePost
    const afterWildcard = api.get;
    api.get = nativePost
    const afterExact = api.get;`);
  const { units: [{ sf }] } = await Workspace.load(root);
  const reads = sf.statements.filter(ts.isVariableStatement).map(statement => statement.declarationList.declarations[0])
    .filter(declaration => declaration.name.getText() !== "nativePost");
  assert.deepEqual(reads.map(read => currentImportedBinding(read.initializer)?.name), ["get", undefined, "post"]);
});

function nestSource(count, inheritedProperty) {
  const parameters = Array.from({ length: count }, (_, i) => `@Optional() @Inject("external-${i}") dep${i}?: unknown`);
  const children = Array.from({ length: count }, (_, i) => `@Injectable() class Consumer${i} extends Base {}`);
  return `import {Injectable, Optional, Inject} from "@nestjs/common";
    @Injectable() class Base { constructor(${parameters.join(",")}) {} ${inheritedProperty ? '@Inject("external-property") field;' : ""} }
    ${children.join("\n")}`;
}

for (const inheritedProperty of [false, true]) test(`inherited Nest dependencies ${inheritedProperty ? "with" : "without"} property injection share and charge missing lookups`, async t => {
  const work = [];
  for (const count of [250, 500]) {
    const root = await fixture(t, nestSource(count, inheritedProperty));
    const workspace = await Workspace.load(root);
    const original = Map.prototype.get;
    let lookups = 0;
    Map.prototype.get = function (key) {
      if (typeof key === "string" && key.startsWith("string:external-")) lookups++;
      return original.call(this, key);
    };
    try {
      const measured = countWork("Nest lifetime", () => providerLifetimes(workspace));
      assert.equal(measured.value.size, count + 1);
      assert.ok([...measured.value.values()].every(entry => entry.kind === "singleton"));
      assert.ok(lookups >= count && lookups < count * 6, `${lookups} token lookups for ${count} inherited parameters`);
      assert.ok(measured.work >= lookups && measured.work < projectWorkLimit(workspace.units.map(unit => unit.sf)));
      work.push(measured.work);
    } finally { Map.prototype.get = original; }
    if (count === 500) assert.equal((await runAudit(root)).complete, true);
  }
  assert.ok(work[1] < work[0] * 2.4, String(work));
});

test("wide resolved Nest dependencies propagate request scope without rebuilding every consumer's edges", async t => {
  const work = [];
  for (const count of [160, 320]) {
    const names = Array.from({ length: count }, (_, i) => `Consumer${i}`);
    const injections = names.map((_, i) => `@Inject("port-${i}") port${i}`);
    const values = names.map((_, i) => `{provide:"port-${i}", useValue:{}, scope:Scope.${i === 0 ? "REQUEST" : "DEFAULT"}}`);
    const classes = names.map(name => `@Injectable() class ${name} extends Base {}`);
    const root = await fixture(t, `import {Injectable, Inject, Module, Scope} from "@nestjs/common";
      class Base { constructor(${injections.join(",")}) {} }
      ${classes.join("\n")}
      @Module({providers:[${[...names, ...values].join(",")}]}) class App {}`);
    const workspace = await Workspace.load(root);
    const measured = countWork("Nest lifetime", () => providerLifetimes(workspace));
    const consumers = [...measured.value].filter(([owner]) => ts.isClassDeclaration(owner) && owner.name.text.startsWith("Consumer"));
    assert.equal(consumers.length, count);
    assert.ok(consumers.every(([, scope]) => scope.kind === "request"));
    work.push(measured.work);
  }
  assert.ok(work[1] < work[0] * 2.4, String(work));
});

test("shared constructor scopes follow each module's bindings and propagate to transient dependencies", async t => {
  const root = await fixture(t, `import {Inject, Injectable, Module, Scope} from "@nestjs/common";
    class Base { constructor(@Inject("port") port, @Inject("worker") worker) {} }
    @Injectable() class First extends Base {}
    @Injectable() class Second extends Base {}
    @Injectable() class OtherModule extends Base {}
    @Injectable({scope: Scope.TRANSIENT}) class Worker {}
    @Module({providers: [First, {provide: "second", useClass: Second},
      {provide: "port", scope: Scope.REQUEST, useValue: {}}, {provide: "worker", useClass: Worker}]}) class A {}
    @Module({providers: [OtherModule, {provide: "port", useValue: {}}]}) class B {}`);
  const workspace = await Workspace.load(root);
  const values = new Map([...providerLifetimes(workspace)]
    .filter(([node]) => ts.isClassDeclaration(node)).map(([node, scope]) => [node.name.text, scope]));
  assert.equal(values.get("First").kind, "request");
  assert.equal(values.get("Second").kind, "request");
  assert.equal(values.get("OtherModule").kind, "singleton");
  assert.deepEqual(values.get("Worker"), { kind: "transient", requestConsumer: true });
});

test("reporting hundreds of findings preserves snippets without a whole-file split per finding", async t => {
  const statements = Array.from({ length: 800 }, (_, i) => `  await prisma.model${i}.findMany();`);
  const source = ["export async function GET(prisma) {", ...statements, "}"].join("\n");
  const root = await fixture(t, source);
  let splits = 0;
  const original = String.prototype.split;
  String.prototype.split = function (separator, ...args) {
    if (this === source && separator === "\n") splits++;
    return original.call(this, separator, ...args);
  };
  let report;
  try { report = await runAudit(root); }
  finally { String.prototype.split = original; }
  assert.equal(report.complete, true);
  const findings = report.findings.filter(finding => finding.id === "unbounded-read");
  assert.equal(findings.length, statements.length);
  assert.equal(splits, 0);
  const middle = findings.find(finding => finding.line === 402);
  assert.equal(middle.snippet, statements.slice(399, 402).join("\n"));
});

test("indexed snippets retain first and last lines, parser line breaks, and the output bound", () => {
  const parse = text => ts.createSourceFile("model.ts", text, ts.ScriptTarget.Latest, true);
  const source = parse("first\nsecond\nthird\nfourth");
  assert.equal(sourceSnippetAt(source, 1), "first\nsecond");
  assert.equal(sourceSnippetAt(source, 4), "third\nfourth");
  assert.equal(sourceSnippetAt(parse("first\u2028second\u2028third\u2028fourth"), 3), "second\u2028third\u2028fourth");
  assert.equal(sourceSnippetAt(parse("x".repeat(1000)), 1), "x".repeat(500));
});
