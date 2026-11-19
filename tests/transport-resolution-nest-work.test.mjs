import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { AnalysisBudget } from "../dist/analysisBudget.js";
import { initializeBindings } from "../dist/bindings.js";
import { SourceProject } from "../dist/project.js";
import { runAudit } from "../dist/runner.js";
import { staticReturns } from "../dist/staticValues.js";

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), "scale-transport-nest-work-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
  return root;
}

async function measured(run) {
  const work = new Map();
  const original = AnalysisBudget.prototype.take;
  AnalysisBudget.prototype.take = function (count = 1) {
    work.set(this.label, (work.get(this.label) ?? 0) + count);
    return original.call(this, count);
  };
  try { return { value: await run(work), work }; }
  finally { AnalysisBudget.prototype.take = original; }
}

function aliases(count, warm = false, cyclic = false) {
  const lines = [
    'import axios from "axios"; import other from "other-client";',
    cyclic ? "let first = axios, second = other; if (a) first = second; if (b) second = first; const c0 = first, c1 = second;"
      : "const c0 = axios; const c1 = other;",
  ];
  for (let i = 2; i <= count; i++) {
    lines.push(`const c${i} = flags[${i}] ? c${i - 1} : c${i - 2};`);
    if (warm && i === 25) lines.push("c25.early = custom;");
  }
  lines.push(`c${count}.get = axios.post;`, 'export function GET() { return axios.get("/health", {id:123}); }');
  return lines.join("\n");
}

test("shared conditional transport aliases charge by unique origins and keep uncertain replacements manual", async t => {
  const charges = [];
  for (const count of [16, 32]) {
    const root = await fixture(t, { "route.ts": aliases(count) });
    const { value, work } = await measured(() => runAudit(root, { codemod: "diff" }));
    assert.equal(value.complete, true);
    assert.equal(value.codemod.edits.length, 0);
    assert.equal(value.findings.filter(f => f.id === "outbound-no-timeout").length, 1);
    charges.push(work.get("Promise binding writes"));
  }
  assert.ok(charges[0] > 0 && charges[1] < charges[0] * 2.6, `binding work ${charges}`);
});

for (const warm of [false, true]) test(`transport alias depth remains strict with a ${warm ? "warm" : "cold"} summary`, async t => {
  const root = await fixture(t, { "route.ts": aliases(70, warm) });
  const report = await runAudit(root);
  assert.equal(report.complete, false);
  assert.ok(report.detectors.some(d => d.reason === "Binding resolution depth limit exceeded"));
});

test("closed cycles in a shared transport graph retain uncertain writes and bounded work", async t => {
  const root = await fixture(t, { "route.ts": aliases(32, false, true) });
  const { value, work } = await measured(() => runAudit(root, { codemod: "diff" }));
  assert.equal(value.complete, true);
  assert.equal(value.codemod.edits.length, 0);
  assert.ok(work.get("Promise binding writes") < 2_000);
});

test("TypeScript path resolution reuses successful and failed lookups and preserves precedence", async t => {
  const paths = Object.fromEntries(Array.from({ length: 320 }, (_, i) => [`@feature${i}/*`, [`pkg${i}/*`]]));
  Object.assign(paths, { "@area/*": ["broad/*"], "@area/nested/*": ["narrow/*"], "@area/nested/exact": ["exact"] });
  const root = await fixture(t, { "tsconfig.json": JSON.stringify({ compilerOptions: { paths } }) });
  const siblings = Array.from({ length: 320 }, (_, i) => `service${i}.ts`);
  const names = ["main.ts", "broad/item.ts", "narrow/item.ts", "exact.ts", ...siblings];
  const units = names.map(rel => ({ rel, sf: ts.createSourceFile(rel, "", ts.ScriptTarget.Latest, true) }));
  const project = await SourceProject.create(root, units.map(({ rel }) => ({ rel })));
  assert.equal(project.resolve("main.ts", "@area/nested/exact"), undefined);
  await initializeBindings(root, units, project);
  const { value, work } = await measured(work => {
    const lookup = () => [
      project.resolve("main.ts", "@area/nested/exact"),
      project.resolve("main.ts", "@area/nested/item"),
      project.resolve("main.ts", "@area/item"),
      project.resolve("main.ts", "@absent/item"),
    ];
    const first = lookup(), cold = work.get("Module resolution");
    for (let i = 0; i < 320; i++) assert.deepEqual(lookup(), first);
    for (const from of siblings) assert.equal(project.resolve(from, "@absent/item"), undefined);
    return { first, cold };
  });
  assert.deepEqual(value.first, ["exact.ts", "narrow/item.ts", "broad/item.ts", undefined]);
  assert.ok(value.cold >= 320, "the shared budget covers wildcard compilation");
  assert.ok(work.get("Module resolution") - value.cold <= 320 * 8, "lookups sharing a compiler config reuse hits and misses");
});

function nestSource(count) {
  return [
    'import {Module} from "@nestjs/common";',
    "@Module({}) class Dynamic {",
    ...Array.from({ length: count }, (_, i) => `method${i}() {}`),
    "static forFeature(tag) {",
    ...Array.from({ length: count }, (_, i) => `void ${i};`),
    "return { module: Dynamic }; } }",
    `@Module({ imports: [${Array.from({ length: count }, (_, i) => `Dynamic.forFeature("tenant${i}")`).join(",")}] }) export class App {}`,
  ].join("\n");
}

test("400 repeated Nest registrations finish the full audit with near-linear bound work", async t => {
  const samples = [];
  for (const count of [200, 400]) {
    const root = await fixture(t, { "main.ts": nestSource(count) });
    const { value, work } = await measured(() => runAudit(root));
    assert.equal(value.complete, true, JSON.stringify(value.detectors.filter(d => d.reason)));
    assert.equal(value.findings.length, 0);
    assert.ok(work.get("Static module returns") >= count);
    assert.ok(work.get("Static module returns") < count * 6, "factory body visited once");
    assert.ok(work.get("Nest lifetime") > work.get("Static module returns"));
    samples.push(work);
  }
  for (const name of ["Nest lifetime", "Request reachability"]) {
    assert.ok(samples[1].get(name) < 2.6 * samples[0].get(name), `${name} ${samples.map(work => work.get(name))}`);
  }
});

test("a Nest conditional return cache rechecks parameter outcomes, defaults, and unknown branches", () => {
  const source = [
    "class Dynamic { static build(first = true, second = false) {",
    "if (first) return 'first'; return second ? 'second' : 'last'; } }",
    "Dynamic.build(); Dynamic.build(false, true); Dynamic.build(false, false); Dynamic.build(x, y);",
    "Dynamic.build(false, true); Dynamic.build(); Dynamic.build(true, true);",
  ].join("\n");
  const sf = ts.createSourceFile("conditional.ts", source, ts.ScriptTarget.Latest, true);
  const budget = new AnalysisBudget("Test Nest lifetime");
  const results = sf.statements.filter(ts.isExpressionStatement).map(s => staticReturns(s.expression, budget).map(value => value.text));
  assert.deepEqual(results, [["first"], ["second"], ["last"], ["first", "second", "last"], ["second"], ["first"], ["first"]]);
});

test("a cached shallow Nest return does not bypass depth checks in a newly selected branch", () => {
  const source = `class Dynamic { static build(flag) { if (flag) ${"{".repeat(70)}return 2;${"}".repeat(70)} return 1; } }
    Dynamic.build(false); Dynamic.build(true); Dynamic.build(false);`;
  const sf = ts.createSourceFile("depth.ts", source, ts.ScriptTarget.Latest, true);
  const budget = new AnalysisBudget("Test Nest lifetime");
  const calls = sf.statements.filter(ts.isExpressionStatement).map(statement => statement.expression);
  assert.equal(staticReturns(calls[0], budget)[0].text, "1");
  assert.throws(() => staticReturns(calls[1], budget), /Static return recursion limit exceeded/);
  assert.equal(staticReturns(calls[2], budget)[0].text, "1");
});

test("the Nest return walk charges the project and the existing per-evaluation limit", () => {
  const source = "class Dynamic { static build() { void 0; return 1; } } Dynamic.build();";
  const sf = ts.createSourceFile("limits.ts", source, ts.ScriptTarget.Latest, true);
  const call = sf.statements[1].expression;
  assert.throws(() => staticReturns(call, new AnalysisBudget("Shared registration", 3)), /Shared registration analysis work budget exceeded/);
  const shared = new AnalysisBudget("Shared registration");
  const original = AnalysisBudget.prototype.take;
  AnalysisBudget.prototype.take = function (count = 1) {
    if (this.label === "Static module returns") this.remaining = 0;
    return original.call(this, count);
  };
  try { assert.throws(() => staticReturns(call, shared), /Static module returns analysis work budget exceeded/); }
  finally { AnalysisBudget.prototype.take = original; }
  assert.equal(staticReturns(call, shared)[0].text, "1");
});

test("request completion still evaluates entry defaults and parameter-dependent bodies at each call", async t => {
  const source = [
    'import {readFileSync} from "node:fs";',
    "function fail() { throw new Error(); }",
    "class Dynamic { static build(tag = fail()) { void 0; return { module: Dynamic }; }",
    "static choose(tag) { if (tag) throw new Error(); return { module: Dynamic }; } }",
    "export function GET() { Dynamic.build(1); Dynamic.choose(false); return readFileSync('included'); }",
    "export function POST() { Dynamic.build(); return readFileSync('default threw'); }",
    "export function PUT() { Dynamic.choose(true); return readFileSync('body threw'); }",
  ].join("\n");
  const root = await fixture(t, { "route.ts": source });
  const report = await runAudit(root);
  assert.equal(report.complete, true);
  assert.deepEqual(report.findings.filter(f => f.id === "sync-io" && f.severity === "high").map(f => f.line), [5]);
});
