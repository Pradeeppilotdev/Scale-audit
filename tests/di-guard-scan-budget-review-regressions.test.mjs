import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { AnalysisBudget, AnalysisLimitError, projectWorkLimit } from "../dist/analysisBudget.js";
import { containerLifetimes } from "../dist/containerLifetimes.js";
import { runAudit } from "../dist/runner.js";
import { Workspace } from "../dist/workspace.js";

const header = "import{PrismaClient}from'@prisma/client';import{container}from'tsyringe';class Db{client=new PrismaClient();}";
const registration = "container.registerSingleton('db',Db);";

async function withSource(source, run) {
  const root = await mkdtemp(join(tmpdir(), "scale-di-guard-scan-review-"));
  try {
    await writeFile(join(root, "route.ts"), source);
    return await run(root, await Workspace.load(root));
  } finally { await rm(root, { recursive: true, force: true }); }
}

function wideSource(count, flag) {
  const registrations = Array.from({ length: count }, (_, index) => `container.registerSingleton('db${index}',Db);`).join("\n");
  return `${header}${flag ? "let initialized=false;" : ""}export function GET(){
    if(${flag ? "!initialized" : "!container.isRegistered('db0')"}){${registrations}${flag ? "initialized=true;" : ""}}
    return container.resolve('db0');}`;
}

async function measured(source) {
  return withSource(source, async (_root, workspace) => {
    const sf = workspace.units[0].sf;
    const owner = sf.statements.find(ts.isClassDeclaration);
    const branch = sf.statements.find(ts.isFunctionDeclaration).body.statements.find(ts.isIfStatement).thenStatement;
    const statements = branch.statements;
    let reads = 0, work = 0;
    Object.defineProperty(branch, "statements", { configurable: true, get() { reads++; return statements; } });
    const take = AnalysisBudget.prototype.take;
    AnalysisBudget.prototype.take = function (units = 1) {
      if (this.label === "DI lifetime") work += units;
      return take.call(this, units);
    };
    try {
      const lifetimes = containerLifetimes(workspace);
      return { lifetime: lifetimes.get(owner)?.kind, reads, work, limit: projectWorkLimit([sf]) };
    } finally {
      AnalysisBudget.prototype.take = take;
      Object.defineProperty(branch, "statements", { configurable: true, writable: true, value: statements });
    }
  });
}

for (const flag of [false, true]) {
  test(`wide ${flag ? "module flag" : "registration token"} guards reuse one charged block scan`, async () => {
    const measurements = [];
    for (const count of [600, 1200, 2400]) {
      const result = await measured(wideSource(count, flag));
      // The unmatched tokens still have a fresh lifetime; sharing facts must
      // not turn a guard for db0 into a guard for every other registration.
      assert.equal(result.lifetime, flag ? "singleton" : "transient");
      assert.ok(result.reads <= 12, `shared branch was traversed ${result.reads} times for ${count} registrations`);
      assert.ok(result.work < result.limit, JSON.stringify(result));
      measurements.push(result.work);
    }
    assert.ok(measurements[1] < measurements[0] * 2.2, String(measurements));
    assert.ok(measurements[2] < measurements[1] * 2.2, String(measurements));
  });
}

for (const [name, setup, body, expected] of [
  ["matching token", "", `if(!container.isRegistered('db')){${registration}}`, "singleton"],
  ["different token", "", `if(!container.isRegistered('other')){${registration}}`, "request"],
  ["different container", "const other=container.createChildContainer();", `if(!other.isRegistered('db')){${registration}}`, "request"],
  ["else branch", "", `if(!container.isRegistered('db')){}else{${registration}}`, "request"],
  ["await before registration", "", `if(!container.isRegistered('db')){await config();${registration}}`, "request"],
  ["await after registration", "", `if(!container.isRegistered('db')){${registration}await config();}`, "request"],
  ["deferred await", "", `if(!container.isRegistered('db')){const later=async()=>await config();${registration}}`, "singleton"],
  ["for-await suspension", "", `if(!container.isRegistered('db')){for await(const config of configs){${registration}break;}}`, "request"],
  ["synchronous for-of", "", `if(!container.isRegistered('db')){for(const config of configs){${registration}break;}}`, "singleton"],
  ["module flag", "let initialized=false;", `if(!initialized){${registration}initialized=true;}`, "singleton"],
  ["flag assignment before registration", "let initialized=false;", `if(!initialized){initialized=true;${registration}}`, "request"],
  ["deferred flag assignment", "let initialized=false;", `if(!initialized){${registration}const init=()=>{initialized=true;};}`, "request"],
  ["other flag assignment", "let initialized=false,other=false;", `if(!initialized){${registration}other=true;}`, "request"],
  ["request local flag", "", `let initialized=false;if(!initialized){${registration}initialized=true;}`, "request"],
]) {
  test(`cached DI guard preserves ${name}`, async () => {
    const source = `${header}${setup}export async function GET(){${body}return container.resolve('db');}`;
    await withSource(source, async (_root, workspace) => {
      const owner = workspace.units[0].sf.statements.find(ts.isClassDeclaration);
      assert.equal(containerLifetimes(workspace).get(owner)?.kind, expected);
    });
  });
}

test("an exhausted DI scan cannot return or retain partial guard facts", async () => {
  await withSource(wideSource(600, true), async (_root, workspace) => {
    const take = AnalysisBudget.prototype.take;
    let forced = false;
    AnalysisBudget.prototype.take = function (units = 1) {
      if (this.label === "DI lifetime" && this.remaining < 180000) { this.remaining = 0; forced = true; }
      return take.call(this, units);
    };
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        assert.throws(() => containerLifetimes(workspace), error => error instanceof AnalysisLimitError
          && error.message === "DI lifetime analysis work budget exceeded");
      }
      assert.equal(forced, true);
    } finally { AnalysisBudget.prototype.take = take; }
    assert.equal([...containerLifetimes(workspace).values()][0]?.kind, "singleton");
  });
});

for (const [name, after, expected] of [
  ["ordinary once-only flag", "initialized=true;", "singleton"],
  ["later reset", "initialized=true;initialized=false;", "request"],
  ["restored after a reset", "initialized=false;initialized=true;", "singleton"],
  ["conditional-only true", "if(flag)initialized=true;", "request"],
  ["dead true write", "if(false)initialized=true;", "request"],
  ["loop-only true", "for(const item of values){initialized=true;}", "request"],
  ["definite true after a loop", "for(const item of values){initialized=false;}initialized=true;", "singleton"],
  ["conditional reset after true", "initialized=true;if(flag)initialized=false;", "request"],
  ["loop reset after true", "initialized=true;for(const item of values){initialized=false;}", "request"],
  ["harmless conditional true after true", "initialized=true;if(flag)initialized=true;", "singleton"],
  ["nested unconditional block", "{initialized=true;}", "singleton"],
  ["unrelated flag reset", "initialized=true;other=false;", "singleton"],
  ["compound reset", "initialized=true;initialized&&=false;", "request"],
  ["object destructuring reset", "initialized=true;({initialized}={initialized:false});", "request"],
  ["array destructuring reset", "initialized=true;[initialized]=[false];", "request"],
  ["iteration target reset", "initialized=true;for(initialized of values){}", "request"],
  ["conditional return before true", "if(flag)return;initialized=true;", "request"],
]) {
  test(`cached module guard requires a retained definite flag: ${name}`, async () => {
    const source = `${header}let initialized=false,other=false;export function GET(){if(!initialized){${registration}${after}}return container.resolve('db');}`;
    await withSource(source, async (_root, workspace) => {
      const owner = workspace.units[0].sf.statements.find(ts.isClassDeclaration);
      assert.equal(containerLifetimes(workspace).get(owner)?.kind, expected);
    });
  });
}

test("reset and skipped flags repeat registration while an ordinary guard registers once", () => {
  for (const [after, expected] of [["initialized=true;", 1], ["initialized=true;initialized=false;", 2], ["if(false)initialized=true;", 2], ["for(const item of [])initialized=true;", 2]]) {
    let registrations = 0;
    const request = new Function("container", `let initialized=false;return function(){if(!initialized){container.registerSingleton();${after}}};`)({registerSingleton(){registrations++;}});
    request(); request();
    assert.equal(registrations, expected);
  }
});

test("DI work exhaustion makes the overall audit incomplete", async () => {
  await withSource(`${header}export function GET(){if(!container.isRegistered('db')){${registration}}return container.resolve('db');}`, async root => {
    const take = AnalysisBudget.prototype.take;
    AnalysisBudget.prototype.take = function (units = 1) {
      if (this.label === "DI lifetime") this.remaining = 0;
      return take.call(this, units);
    };
    try {
      const report = await runAudit(root);
      assert.equal(report.complete, false);
      assert.deepEqual(report.detectors.find(detector => detector.name === "detectPerRequestClients"), {
        name: "detectPerRequestClients", status: "failed", reason: "DI lifetime analysis work budget exceeded",
      });
    } finally { AnalysisBudget.prototype.take = take; }
  });
});
