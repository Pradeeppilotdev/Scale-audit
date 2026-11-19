import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AnalysisBudget, AnalysisLimitError } from "../dist/analysisBudget.js";
import { bindingWriteIndex } from "../dist/bindings.js";
import { Workspace } from "../dist/workspace.js";
import { requestReachability } from "../dist/requestReachability.js";
import { detectSyncIo } from "../dist/detectors/syncIo.js";
import { detectFloatingPromises } from "../dist/detectors/floatingPromise.js";

async function withSource(source, run, files = {}) {
  const root = await mkdtemp(join(tmpdir(), "scale-shared-identity-budget-"));
  try {
    await writeFile(join(root, "server.ts"), source);
    for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);
    return await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

for (const count of [100, 129, 130, 140]) for (const warm of [false, true]) for (const safe of [false, true]) {
  test(`${count} readonly consumers retain depth after ${warm ? "warm" : "cold"} ${safe ? "safe" : "unsafe"} summaries`, async () => {
    const source = Array.from({ length: count }, (_, index) =>
      `function f${index}(p){${index === count - 1 ? safe ? "" : "return p;" : `f${index + 1}(p);`}}`).join("\n")
      + `\nfunction unused(){f0([])}${warm ? `\nfunction warm(){f${Math.floor(count / 2)}([])}` : ""}`;
    await withSource(source, async root => {
      const workspace = await Workspace.load(root);
      if (count <= 129) assert.doesNotThrow(() => requestReachability(workspace));
      else {
        const limited = error => error instanceof AnalysisLimitError && /binding resolution depth limit/.test(error.message);
        assert.throws(() => requestReachability(workspace), limited);
        assert.throws(() => requestReachability(workspace), limited);
      }
    });
  });
}

test("cyclic readonly consumers remain conservative without manufacturing a completed safe summary", async () => {
  await withSource("function one(p){two(p)}function two(p){one(p)}function unused(){one([])}function warm(){two([])}", async root => {
    const workspace = await Workspace.load(root);
    assert.doesNotThrow(() => requestReachability(workspace));
  });
});

test("property-resolution failure cannot leave a reusable partial binding-write index", async () => {
  const aliases = Array.from({ length: 140 }, (_, index) => `const value${index}=value${index + 1};`).join("\n");
  await withSource(`let changed=0;changed=1;${aliases}const value140=()=>{};value0.run=()=>{};`, async root => {
    const workspace = await Workspace.load(root), sf = workspace.units[0].sf;
    const limited = error => error instanceof AnalysisLimitError && /Binding resolution depth limit/.test(error.message);
    assert.throws(() => bindingWriteIndex(sf), limited);
    assert.throws(() => bindingWriteIndex(sf), limited);
  });
});

const syncHeader = "import {createServer} from 'node:http';import * as fs from 'node:fs';";
for (const assignment of [
  "readFileSync=fs.readFileSync;",
  "({readFileSync}={readFileSync:fs.readFileSync});",
  "[readFileSync]=[fs.readFileSync];",
  "({native:readFileSync}={native:fs.readFileSync});",
  "({nested:[readFileSync]}={nested:[fs.readFileSync]});",
  "[readFileSync=fs.readFileSync]=[];",
]) {
  test(`destructuring cannot preserve stale local Sync suppression: ${assignment}`, async () => {
    const findings = await withSource(`${syncHeader}let readFileSync=()=>{};${assignment}createServer(()=>readFileSync('live'));`, detectSyncIo);
    assert.equal(findings.filter(finding => finding.id === "sync-io" && finding.severity === "high").length, 1);
  });
}

test("an unrelated destructuring write preserves proven local Sync suppression", async () => {
  const findings = await withSource(`${syncHeader}let other;const readFileSync=()=>{};({other}={other:fs.readFileSync});createServer(()=>readFileSync());`, detectSyncIo);
  assert.deepEqual(findings, []);
});

async function promiseIds(source) {
  return (await withSource(source, detectFloatingPromises)).map(finding => finding.id);
}

for (const access of ["run", "['run']"]) for (const asyncInitial of [false, true]) for (const receiver of ["a", "b"]) {
  const member = name => access === "run" ? `${name}.run` : `${name}${access}`;
  test(`class property ${access} replacement stays on ${receiver} with ${asyncInitial ? "async" : "sync"} initialization`, async () => {
    const source = `class Task{run=${asyncInitial ? "async" : ""}()=>{}}const a=new Task(),b=new Task();a.run=${asyncInitial ? "" : "async"}()=>{};${member(receiver)}();`;
    assert.deepEqual(await promiseIds(source), (receiver === "a" ? !asyncInitial : asyncInitial) ? ["floating-promise"] : []);
  });
}

for (const [name, source, expected] of [
  ["receiver aliases", "const alias=a;alias.run=()=>{};a.run();b.run();", 1],
  ["mutable receiver capture", "let selected=a;const captured=selected;selected=b;captured.run=()=>{};a.run();b.run();", 1],
  ["reassigned receiver", "let selected=a;selected=b;selected.run=()=>{};a.run();b.run();", 1],
  ["interleaved writes", "a.run();a.run=()=>{};a.run();b.run();a.run=async()=>{};a.run();", 3],
  ["captured callable", "const captured=a.run;a.run=()=>{};captured();b.run();", 2],
  ["external entries", "a.run=()=>{};export function GET(){a.run();b.run();}", 1],
  ["conditional writes", "if(flag)a.run=()=>{};a.run();b.run();", 1],
  ["unknown receivers", "function replace(target:Task){target.run=()=>{}}a.run();b.run();", 0],
]) {
  test(`instance property history preserves ${name}`, async () => {
    assert.equal((await promiseIds(`class Task{run=async()=>{}}const a=new Task(),b=new Task();${source}`)).length, expected);
  });
}

test("instance promise values and rejection handlers keep receiver identity", async () => {
  assert.deepEqual(await promiseIds("class Task{pending=Promise.resolve();error=()=>{}}const a=new Task(),b=new Task();a.pending={then(){}};a.error=null;a.pending.then(()=>{});b.pending.then(()=>{});Promise.reject('x').catch(a.error);Promise.reject('x').catch(b.error);"), ["unhandled-rejection", "unhandled-rejection"]);
});

test("constructors returning shared objects cannot certify distinct property receivers", async () => {
  assert.deepEqual(await promiseIds("const shared={run:async()=>{}};class Task{run=async()=>{};constructor(){return shared}}const a=new Task(),b=new Task();a.run=()=>{};b.run();"), []);
});

for (const [name, setup, allocation, expected] of [
  ["replaced class declaration", "Task=class{run=async()=>{};constructor(){return shared}};", "new Task()", 0],
  ["replaced constructor alias", "let Maker=Task;Maker=class{run=async()=>{};constructor(){return shared}};", "new Maker()", 0],
  ["captured original class", "const Maker=Task;Task=class{run=async()=>{};constructor(){return shared}};", "new Maker()", 1],
  ["captured constructor alias", "let selected=Task;const Maker=selected;selected=class{run=async()=>{};constructor(){return shared}};", "new Maker()", 1],
  ["conditionally replaced declaration", "if(flag)Task=class{run=async()=>{};constructor(){return shared}};", "new Task()", 0],
  ["nested replacement", "function replace(){Task=class{run=async()=>{};constructor(){return shared}}}replace();", "new Task()", 0],
]) {
  test(`${name} preserves constructor identity before separating instance writes`, async () => {
    const source = `const shared={run:async()=>{}};class Task{run=async()=>{}}${setup}
      const a=${allocation},b=${allocation};a.run=()=>{};b.run();`;
    assert.equal((await promiseIds(source)).length, expected);
  });
}

test("instances allocated before a later class replacement retain their separate identities", async () => {
  assert.deepEqual(await promiseIds(`const shared={run:async()=>{}};class Task{run=async()=>{}}
    const a=new Task(),b=new Task();Task=class{run=async()=>{};constructor(){return shared}};
    a.run=()=>{};b.run();`), ["floating-promise"]);
});

for (const [name, factory, expected] of [
  ["native factory", "let make=createRequire;", 1],
  ["replaced native factory", "let make=createRequire;make=()=>()=>({createServer(){}});", 0],
  ["restored native factory", "let make=()=>()=>({createServer(){}});make=createRequire;", 1],
  ["captured native factory", "let original=createRequire;const make=original;original=()=>()=>({createServer(){}});", 1],
  ["captured local factory", "let original=()=>()=>({createServer(){}});const make=original;original=createRequire;", 0],
  ["conditional factory replacement", "let make=createRequire;if(flag)make=()=>()=>({createServer(){}});", 0],
  ["destructured factory replacement", "let make=createRequire;({make}={make:()=>()=>({createServer(){}})});", 0],
  ["cyclic factory aliases", "const make=other;const other=make;", 0],
]) {
  test(`createRequire uses current import identity: ${name}`, async () => {
    const source = `import {createRequire} from 'node:module';import {readFileSync} from 'node:fs';${factory}const require=make(import.meta.url);const http=require('node:http');http.createServer(()=>readFileSync('live'));`;
    const findings = await withSource(source, detectSyncIo);
    assert.equal(findings.filter(finding => finding.id === "sync-io" && finding.severity === "high").length, expected);
  });
}

test("a createRequire loader captures its factory before later replacement", async () => {
  const source = "import {createRequire} from 'node:module';import {readFileSync} from 'node:fs';let make=createRequire;const require=make(import.meta.url);make=()=>()=>({createServer(){}});const http=require('node:http');http.createServer(()=>readFileSync('live'));";
  const findings = await withSource(source, detectSyncIo);
  assert.equal(findings.filter(finding => finding.id === "sync-io" && finding.severity === "high").length, 1);
});

const importFactoryUse = "import {readFileSync} from 'node:fs';const require=make(import.meta.url);const http=require('node:http');http.createServer(()=>readFileSync('live'));";
const exportFactories = [
  ["replaced live factory", "let make=createRequire;make=()=>()=>({createServer(){}});export {make};", 0],
  ["restored live factory", "let make=()=>()=>({createServer(){}});make=createRequire;export {make};", 1],
  ["replacement after export declaration", "let make=createRequire;export {make};make=()=>()=>({createServer(){}});", 0],
  ["restoration after export declaration", "let make=()=>()=>({createServer(){}});export {make};make=createRequire;", 1],
  ["direct exported binding replacement", "export let make=createRequire;make=()=>()=>({createServer(){}});", 0],
  ["direct exported binding restoration", "export let make=()=>()=>({createServer(){}});make=createRequire;", 1],
  ["captured native alias", "let original=createRequire;const make=original;original=()=>()=>({createServer(){}});export {make};", 1],
  ["captured local alias", "let original=()=>()=>({createServer(){}});const make=original;original=createRequire;export {make};", 0],
  ["post-startup native replacement", "export let make=createRequire;export function replace(){make=()=>()=>({createServer(){}})}", 0],
  ["post-startup local restoration", "export let make=()=>()=>({createServer(){}});export function restore(){make=createRequire}", 0],
  ["conditional replacement", "export let make=createRequire;if(flag)make=()=>()=>({createServer(){}});", 0],
];
for (const [name, bridge, expected] of exportFactories) for (const namespace of [false, true]) {
  test(`${name} retains current factory identity through a ${namespace ? "namespace" : "named"} import`, async () => {
    const entry = namespace ? "import * as bridge from './bridge.js';const make=bridge.make;" : "import {make} from './bridge.js';";
    const findings = await withSource(entry + importFactoryUse, detectSyncIo,
      { "bridge.js": "import {createRequire} from 'node:module';" + bridge });
    assert.equal(findings.filter(finding => finding.id === "sync-io" && finding.severity === "high").length, expected);
  });
}

for (const [name, bridge, expected] of [
  ["default expression captures native", "let make=createRequire;export default make;make=()=>()=>({createServer(){}});", 1],
  ["default expression captures local", "let make=()=>()=>({createServer(){}});export default make;make=createRequire;", 0],
  ["named default binding observes replacement", "let make=createRequire;export {make as default};make=()=>()=>({createServer(){}});", 0],
  ["named default binding observes restoration", "let make=()=>()=>({createServer(){}});export {make as default};make=createRequire;", 1],
]) {
  test(`${name} preserves default-export capture semantics`, async () => {
    const findings = await withSource("import make from './bridge.js';" + importFactoryUse, detectSyncIo,
      { "bridge.js": "import {createRequire} from 'node:module';" + bridge });
    assert.equal(findings.filter(finding => finding.id === "sync-io" && finding.severity === "high").length, expected);
  });
}

for (const [bridge, expected] of [
  ["let make=createRequire;make=()=>()=>({createServer(){}});export {make};", 0],
  ["let make=()=>()=>({createServer(){}});make=createRequire;export {make};", 1],
]) for (const forward of ["export {make} from './bridge.js';", "export * from './bridge.js';"]) {
  test(`factory startup identity survives ${forward} after ${bridge}`, async () => {
    const findings = await withSource("import {make} from './forward.js';" + importFactoryUse, detectSyncIo, {
      "bridge.js": "import {createRequire} from 'node:module';" + bridge, "forward.js": forward,
    });
    assert.equal(findings.filter(finding => finding.id === "sync-io" && finding.severity === "high").length, expected);
  });
}

test("cyclic re-exports cannot manufacture native factory identity", async () => {
  const findings = await withSource("import {make} from './first.js';" + importFactoryUse, detectSyncIo, {
    "first.js": "export {make} from './second.js';", "second.js": "export {make} from './first.js';",
  });
  assert.equal(findings.filter(finding => finding.id === "sync-io" && finding.severity === "high").length, 0);
});

for (const count of [40, 140]) {
  test(`${count} indexed re-export modules retain the shared binding depth limit`, async () => {
    const files = {};
    for (let index = 0; index < count; index++) files[`bridge${index}.js`] = index === count - 1
      ? "export {createRequire as make} from 'node:module';"
      : `export {make} from './bridge${index + 1}.js';`;
    const inspect = root => detectSyncIo(root);
    const run = withSource("import {make} from './bridge0.js';" + importFactoryUse, inspect, files);
    if (count > 128) await assert.rejects(run, error => error instanceof AnalysisLimitError && /Binding resolution depth limit/.test(error.message));
    else assert.equal((await run).filter(finding => finding.id === "sync-io" && finding.severity === "high").length, 1);
  });
}

for (const [name, bridge, expected] of [
  ["later named replacement", "exports.make=createRequire;exports.make=()=>()=>({createServer(){}});", 0],
  ["later named restoration", "exports.make=()=>()=>({createServer(){}});exports.make=createRequire;", 1],
  ["later module member replacement", "module.exports.make=createRequire;module.exports.make=()=>()=>({createServer(){}});", 0],
  ["later module member restoration", "module.exports.make=()=>()=>({createServer(){}});module.exports.make=createRequire;", 1],
  ["whole-object replacement", "exports.make=createRequire;module.exports={make:()=>()=>({createServer(){}})};", 0],
  ["whole-object restoration", "exports.make=()=>()=>({createServer(){}});module.exports={make:createRequire};", 1],
  ["duplicate object property replacement", "module.exports={make:createRequire,make:()=>()=>({createServer(){}})};", 0],
  ["duplicate object property restoration", "module.exports={make:()=>()=>({createServer(){}}),make:createRequire};", 1],
  ["whole-object overwrite", "module.exports={make:createRequire};module.exports={};", 0],
  ["detached exports object", "module.exports={make:()=>()=>({createServer(){}})};exports.make=createRequire;", 0],
  ["module receiver after overwrite", "module.exports={};module.exports.make=createRequire;", 1],
  ["post-startup replacement", "exports.make=createRequire;function replace(){exports.make=()=>()=>({createServer(){}})}", 0],
  ["conditional replacement", "exports.make=createRequire;if(flag)exports.make=()=>()=>({createServer(){}});", 0],
  ["computed replacement", "exports.make=createRequire;exports['make']=()=>()=>({createServer(){}});", 0],
  ["computed module replacement", "exports.make=createRequire;module['exports']={};", 0],
  ["native mutator replacement", "exports.make=createRequire;Object.assign(exports,{make:()=>()=>({createServer(){}})});", 0],
  ["captured native source", "let make=createRequire;exports.make=make;make=()=>()=>({createServer(){}});", 1],
  ["captured local source", "let make=()=>()=>({createServer(){}});exports.make=make;make=createRequire;", 0],
  ["unrelated destructuring keys", "exports.make=createRequire;let other;({exports:other}={exports:0});", 1],
]) {
  test(`CJS factory identity respects ${name}`, async () => {
    const findings = await withSource("import {make} from './bridge.js';" + importFactoryUse, detectSyncIo,
      { "bridge.js": "const {createRequire}=require('node:module');" + bridge });
    assert.equal(findings.filter(finding => finding.id === "sync-io" && finding.severity === "high").length, expected);
  });
}
for (const [bridge, expected] of [
  ["module.exports=createRequire;module.exports=()=>()=>({createServer(){}});", 0],
  ["module.exports=()=>()=>({createServer(){}});module.exports=createRequire;", 1],
]) {
  test(`a CJS default factory observes its final whole-export assignment: ${bridge}`, async () => {
    const findings = await withSource("import make from './bridge.js';" + importFactoryUse, detectSyncIo,
      { "bridge.js": "const {createRequire}=require('node:module');" + bridge });
    assert.equal(findings.filter(finding => finding.id === "sync-io" && finding.severity === "high").length, expected);
  });
}

test("repeated native factories reuse a charged wide-module export index", async () => {
  const work = [];
  for (const count of [100, 200]) {
    const bridge = "import {createRequire} from 'node:module';export let make=()=>{};make=createRequire;"
      + Array.from({ length: count * 3 }, (_, index) => `export const unused${index}=${index};`).join("\n");
    const source = "import {make} from './bridge.js';import {readFileSync} from 'node:fs';"
      + Array.from({ length: count }, () => `{const require=make(import.meta.url);const http=require('node:http');http.createServer(()=>readFileSync('live'));}`).join("\n");
    const take = AnalysisBudget.prototype.take;
    let charged = 0;
    AnalysisBudget.prototype.take = function (units = 1) {
      if (this.label === "Promise binding writes") charged += units;
      return take.call(this, units);
    };
    try {
      const findings = await withSource(source, detectSyncIo, { "bridge.js": bridge });
      assert.equal(findings.filter(finding => finding.id === "sync-io" && finding.severity === "high").length, count);
      work.push(charged);
    } finally { AnalysisBudget.prototype.take = take; }
  }
  assert.ok(work[1] < work[0] * 2.4, `expected reused export syntax, observed ${work}`);
});

test("instance property histories reuse grouped writes with near-linear work", async () => {
  const work = [];
  for (const count of [250, 500]) {
    const source = `class Task{run=()=>{}}const a=new Task(),b=new Task();${"a.run=async()=>{};".repeat(count)}${"a.run();b.run();".repeat(count)}`;
    const take = AnalysisBudget.prototype.take;
    let charged = 0;
    AnalysisBudget.prototype.take = function (units = 1) {
      if (this.label === "Promise binding writes") charged += units;
      return take.call(this, units);
    };
    try {
      assert.equal((await promiseIds(source)).length, count);
      work.push(charged);
    } finally { AnalysisBudget.prototype.take = take; }
  }
  assert.ok(work[1] < work[0] * 2.4, `expected reused histories, observed ${work}`);
});
