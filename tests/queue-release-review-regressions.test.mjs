import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnalysisBudget, AnalysisLimitError } from "../dist/analysisBudget.js";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";
import { runAudit } from "../dist/runner.js";
import { Workspace } from "../dist/workspace.js";

const header = "import {createServer} from 'node:http';";
const common = `const jobs=[];let count=0;
function work(job){if(job!==undefined)count--;}
function full(){return count>=10;}
function equal(){return count===3;}
setInterval(()=>work(jobs.shift()),100);`;
const push = "jobs.push(req.url);count++;";
async function withSource(source, run = detectQueueBackpressure, {extension="ts", files={}} = {}) {
  const root = await mkdtemp(join(tmpdir(), "scale-queue-release-review-"));
  try {
    await writeFile(join(root, `server.${extension}`), source);
    for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
    return await run(root);
  } finally { await rm(root, {recursive:true, force:true}); }
}
const route = (body, async=false) => `createServer(${async ? "async " : ""}req=>{${body}});`;
const audit = (body, options) => withSource(header+common
  + (/\benqueue\b/.test(body) ? "function enqueue(job){jobs.push(job);count++;}" : "") +body, detectQueueBackpressure, options);

for (const guard of [
  "if(req.url==='/health')return;", "if(!req.authorized)return;", "if(req.url.length>100)return;",
  "if(!admitJob(req))return;", "{if(req.authorized)return;}", "try{}catch{return;}",
  "try{if(req.authorized)throw 0;}catch{return;}",
  "if(req.authorized){if(count>=10)return;}",
  "try{mayThrow();if(count>=10)return;}catch{}",
  "try{class Setup{static value=mayThrow();}if(count>=10)return;}catch{}",
  "try{if(mayThrow())return;if(count>=10)return;}catch{}",
  "try{if(req.invalid)throw 0;if(count>=10)return;}catch{}",
  "try{if(count>=10){mayThrow();return;}}catch{}",
  "try{if(count>=10)return mayThrow();}catch{}",
  "try{if(count>=10){const response=mayThrow();return;}}catch{}",
  "try{if(mayThrow()||count>=10)return;}catch{}",
  "try{if(Boolean(count>=10,mayThrow()))return;}catch{}",
  "try{if(Boolean.call(null,count>=10,mayThrow()))return;}catch{}",
  "try{if(full(mayThrow()))return;}catch{}",
  "try{if(full.call(mayThrow()))return;}catch{}",
  "try{if(req.blocked||count>=10)return;}catch{}",
  "done:{try{if(count>=10)return;}finally{break done;}}",
]) for (const producer of [push, "enqueue(req.url);", "[req.url].forEach(enqueue);"]) {
  test(`unrelated or bypassable exit does not supply admission: ${guard} ${producer}`, async () => {
    assert.equal((await audit(route(guard+producer))).length, 1);
  });
}
for (const guard of [
  "if(count>=10)return;", "{if(count>=10)return;}",
  "try{if(count>=10)return;}catch{}", "try{if(count>=10)throw 0;}catch{return;}",
  "try{if(count>=10)throw 0;}catch(e){throw e;}",
  "try{if(count>=10)throw 0;}finally{console.log('checked');}",
  "try{}finally{if(count>=10)return;}",
  "try{if(req.invalid)return;}finally{if(count>=10)return;}",
  "try{{{const label='queue';}}if(count>=10)return;}catch{}",
  "try{if(Boolean(count>=10))return;}catch{}",
  "try{if(full())return;}catch{}",
  "try{if(count>=10)return false;}catch{}",
  "try{if(count>=10){const label='full';return;}}catch{}",
  "try{if(jobs.length>=10)return;}catch{}",
  "try{if((false&&mayThrow())||count>=10)return;}catch{}",
  "try{if(count>=10){mayThrow();return;}}catch{return;}",
]) {
  test(`actual capacity exits still protect admission: ${guard}`, async () => {
    assert.deepEqual(await audit(route(guard+push)), []);
  });
}

const fallbacks = ["false", "true", "0", "null", "undefined", "req.disabled", "unreachableFallback()"];
for (const fallback of fallbacks) for (const predicate of ["count===3", "!!(count===3)", "Boolean(count===3)", "equal()", "count===3?true:false"]) {
  test(`non-nullish ${predicate} retains scalar bounds through ?? ${fallback}`, async () => {
    const guard = `if((${predicate})??${fallback})return;`;
    assert.deepEqual(await audit(route(guard+push)), []);
    assert.equal((await audit(route(guard+push+push))).length, 1);
  });
}
for (const fallback of fallbacks) {
  test(`?? ${fallback} retains a shared equality barrier across request routes`, async () => {
    assert.deepEqual(await audit(route(`if((count===3)??${fallback})return;${push}`)
      +route(`if((count===3)??${fallback})return;${push}`)), []);
    assert.equal((await audit(route(`if((count===3)??${fallback})return;${push}`)
      +route(`if((count===4)??${fallback})return;${push}`))).length, 1);
  });
}
for (const predicate of ["count>=10", "count===3", "!!count"]) {
  test(`an unreachable await fallback does not stale ${predicate}`, async () => {
    assert.deepEqual(await audit(route(`if((${predicate})??await load())return;${push}`, true)), []);
  });
}

const globalPatches = [
  "globalThis.globalThis.Boolean=()=>false;", "globalThis.global.Boolean=()=>false;",
  "global.globalThis.Boolean=()=>false;", "globalThis['globalThis']['Boolean']=()=>false;",
  "const hostKey='globalThis';globalThis[hostKey].Boolean=()=>false;",
  "const host=globalThis.globalThis;const alias=host;alias.Boolean=()=>false;",
  "Object.assign(globalThis.globalThis,{Boolean:()=>false});",
  "Object.defineProperty(globalThis.global,'Boolean',{value:()=>false});",
  "globalThis.__defineGetter__('Boolean',()=>()=>false);",
  "globalThis.globalThis.__defineGetter__('Boolean',()=>()=>false);",
  "const host=globalThis.global;const property='Boolean';host.__defineGetter__(property,()=>()=>false);",
  "const define='__defineGetter__';globalThis[define]('Boolean',()=>()=>false);",
];
for (const extension of ["ts", "js"]) for (const patch of globalPatches) {
  test(`${extension} global mutation cannot preserve native Boolean evidence: ${patch}`, async () => {
    assert.equal((await audit(patch+route(`if(Boolean(count>=10))return;${push}`), {extension})).length, 1);
    assert.deepEqual(await audit(`const cast=Boolean;${patch}`+route(`if(cast(count>=10))return;${push}`), {extension}), []);
  });
}
for (const extension of ["ts", "js"]) for (const patch of [
  "globalThis.globalThis.Boolean=()=>false;", "globalThis.__defineGetter__('Boolean',()=>()=>false);",
]) {
  test(`${extension} sibling-module Boolean mutations remain visible`, async () => {
    assert.equal((await withSource(`import './patch.${extension}';`+header+common+route(`if(Boolean(count>=10))return;${push}`),
      detectQueueBackpressure, {extension, files:{[`patch.${extension}`]:patch}})).length, 1);
  });
}
for (const setup of [
  "globalThis.__defineGetter__('unrelated',()=>false);",
  "function configure(globalThis){globalThis.globalThis.Boolean=()=>false;}",
  "function configure(global){global.globalThis.__defineGetter__('Boolean',()=>()=>false);}",
]) {
  test(`unrelated or shadowed host uses preserve native admission: ${setup}`, async () => {
    assert.deepEqual(await audit(setup+route(`if(Boolean(count>=10))return;${push}`)), []);
  });
}

test("independent runtime controls distinguish capacity, unrelated exits and skipped scalar limits", () => {
  for (const [setup, guard, batch, expected] of [
    ["", "if(count>=10)return;", 1, 10],
    ["", "if(req.url==='/health')return;", 1, 1000],
    ["const admitJob=()=>true;", "if(!admitJob(req))return;", 1, 1000],
    ["", "if((count===3)??true)return;", 2, 2000],
    ["globalThis.globalThis.Boolean=()=>false;", "if(Boolean(count>=10))return;", 1, 1000],
    ["globalThis.__defineGetter__('Boolean',()=>()=>false);", "if(Boolean(count>=10))return;", 1, 1000],
    ["function mayThrow(){throw 0;}", "try{if(count>=10)return mayThrow();}catch{}", 1, 1000],
    ["function mayThrow(){throw 0;}", "try{if(mayThrow()||count>=10)return;}catch{}", 1, 1000],
    ["function mayThrow(){throw 0;}", "try{if(count>=10)return mayThrow();}catch{return;}", 1, 10],
  ]) {
    const context={setInterval(){},createServer(fn){context.handler=fn;}};
    vm.runInNewContext(common+setup+route(guard+push.repeat(batch))+"globalThis.size=()=>jobs.length;", context);
    for (let i=0;i<1000;i++) context.handler({url:'/enqueue'});
    assert.equal(context.size(), expected);
  }
});

function descriptorGraph(depth, leaf="value.label=1;") {
  const helpers="function annotate0(value){"+leaf+"}"+Array.from({length:depth}, (_,i)=>
    `function annotate${i+1}(value){annotate${i}(value);annotate${i}(value);}`).join("\n");
  return header+common+helpers+route(push);
}
function graphSource(depth) {
  return descriptorGraph(depth).replace("setInterval(()=>work(jobs.shift()),100);", "setInterval(()=>work(jobs.shift()),100).unref();");
}
async function measured(source) {
  const take=AnalysisBudget.prototype.take;let work=0;
  AnalysisBudget.prototype.take=function(units=1){if(this.label==='Queue backpressure')work+=units;return take.call(this,units);};
  try{return {findings:await withSource(source),work:()=>work};}
  finally{AnalysisBudget.prototype.take=take;}
}
test("caught shared predicate graphs retain linear nonthrowing proof work", async () => {
  const source = depth => header+common+"function guard0(){return count>=10;}"
    +Array.from({length:depth},(_,i)=>`function guard${i+1}(){return guard${i}()||guard${i}();}`).join("\n")
    +route(`try{if(guard${depth}())return;}catch{}${push}`);
  const first=await measured(source(8)),second=await measured(source(16));
  assert.deepEqual(first.findings,[]);assert.deepEqual(second.findings,[]);
  assert.ok(second.work()<first.work()*2.5,`${first.work()} -> ${second.work()}`);
});
test("uncalled shared descriptor graphs complete without expanding every call path", async () => {
  const report=await withSource(graphSource(13),runAudit);
  assert.equal(report.complete,true);
  assert.equal(report.findings.filter(f=>f.id==='unbounded-request-queue').length,1);
  const first=await measured(graphSource(30)),second=await measured(graphSource(60));
  assert.equal(first.findings.length,1);assert.equal(second.findings.length,1);
  assert.ok(second.work()<first.work()*2.5,`${first.work()} -> ${second.work()}`);
});

for (const [effect, expected] of [["value.writable=true;",1],["value.enumerable=true;",0]]) {
  test(`cached descriptor graphs retain ${effect}`, async () => {
    const helpers="function annotate0(value){"+effect+"}"+Array.from({length:18},(_,i)=>
      `function annotate${i+1}(value){annotate${i}(value);annotate${i}(value);}`).join("\n");
    const source=header+common.replace("setInterval(()=>work(jobs.shift()),100);", "")+helpers+`
      const probe=setInterval(()=>{},100);clearInterval(probe);const prototype=Object.getPrototypeOf(probe);
      const patch={};const descriptor={value(){clearInterval(this);return this;}};
      annotate18(descriptor);Object.defineProperty(patch,'unref',descriptor);Object.assign(prototype,patch);
      ${route(push)}setInterval(()=>work(jobs.shift()),100).unref();`;
    assert.equal((await withSource(source)).length,expected);
  });
}
for (const key of ["entry", "other"]) {
  test(`composed descriptor effects retain forwarded key ${key}`, async () => {
    const source=header+common.replace("setInterval(()=>work(jobs.shift()),100);", "")+`
      const probe=setInterval(()=>{},100);clearInterval(probe);const prototype=Object.getPrototypeOf(probe);
      const patch={};const descriptor={value(){clearInterval(this);return this;}};const bag={entry:descriptor,other:{}};
      function leaf(value,key){value[key].enumerable=true;}
      function shared(value,key){leaf(value,key);leaf(value,key);}
      function root(value,key){shared(value,key);shared(value,key);}
      root(bag,'${key}');Object.defineProperty(patch,'unref',descriptor);Object.assign(prototype,patch);
      ${route(push)}setInterval(()=>work(jobs.shift()),100).unref();`;
    assert.equal((await withSource(source)).length,key==='entry'?0:1);
  });
}
test("a failed descriptor summary is not published as a complete result", async () => {
  await withSource(graphSource(20), async root => {
    const workspace=await Workspace.load(root),take=AnalysisBudget.prototype.take;let visits=0;
    AnalysisBudget.prototype.take=function(units=1){
      if(this.label==='Queue backpressure'&&new Error().stack.includes('descriptorParameterWrites')&&++visits===80)
        throw new AnalysisLimitError('forced descriptor summary exhaustion');
      return take.call(this,units);
    };
    try{await assert.rejects(()=>detectQueueBackpressure(root,workspace),/forced descriptor summary exhaustion/);}
    finally{AnalysisBudget.prototype.take=take;}
    assert.equal((await detectQueueBackpressure(root,workspace)).length,1);
  });
});
