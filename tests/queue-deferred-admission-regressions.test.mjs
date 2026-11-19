import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AnalysisBudget } from "../dist/analysisBudget.js";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";
import { runAudit } from "../dist/runner.js";

const header = "import {createServer} from 'node:http';";
const queue = "const jobs=[]; let count=0; function work(job){if(job!==undefined) count--;}";
const timer = "setInterval(()=>work(jobs.shift()),100);";
const guard = "if(jobs.length>=10)return;";
const counterGuard = "if(count>=10)return;";
const push = "jobs.push(req.url)";
async function audit(body, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "scale-queue-deferred-"));
  try {
    const src = [header, queue, options.setup ?? "", options.timer ?? timer, "createServer(async(req,res)=>{", body, "});"].join("\n");
    await writeFile(join(root,"api.ts"), src);
    return await (options.inspect ?? detectQueueBackpressure)(root);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
}

for (const [name, dispatch, setup = ""] of [
  ["fulfilled then", cb => `Promise.resolve(1).then(${cb})`],
  ["rejected catch", cb => `Promise.reject(1).catch(${cb})`],
  ["settled finally", cb => `Promise.resolve().finally(${cb})`],
  ["queueMicrotask", cb => `queueMicrotask(${cb})`],
  ["setImmediate", cb => `setImmediate(${cb})`],
  ["process.nextTick", cb => `process.nextTick(${cb})`],
  ["imported setImmediate", cb => `later(${cb})`, "import {setImmediate as later} from 'node:timers';"],
  ["imported nextTick", cb => `later(${cb})`, "import {nextTick as later} from 'node:process';"],
]) {
  test(`a guard must be fresh at enqueue time for ${name}`, async () => {
    assert.equal((await audit(guard+dispatch("()=>{"+push+"}")+";",{setup})).length, 1);
    assert.equal((await audit(dispatch("()=>{"+guard+push+"}")+";",{setup})).length, 0);
    assert.equal((await audit(dispatch("()=>{"+push+"}")+";",{setup})).length, 1);
  });
}

for (const [label, body, expected, setup] of [
  ["skipped rejection handler","Promise.resolve(1).catch(()=>"+push+");",0],
  ["skipped fulfillment handler","Promise.reject(1).then(()=>"+push+",()=>{});",0],
  ["shadow scheduler","queueMicrotask(()=>"+push+");",0,"function queueMicrotask(fn){}"],
  ["replaced scheduler","setImmediate(()=>"+push+");",0,"Object.assign(globalThis,{setImmediate:()=>0});"],
  ["replaced process method","process.nextTick(()=>"+push+");",0,"process.nextTick=()=>{};"],
  ["cancelled Immediate","const ticket=setImmediate(()=>"+push+");clearImmediate(ticket);",0],
  ["unused Immediate handle","const ticket=setImmediate(()=>"+push+");",1],
  ["disposed Immediate handle","using ticket=setImmediate(()=>"+push+");",0],
  ["Immediate returned by the HTTP handler","return setImmediate(()=>"+push+");",1],
  ["deferred argument forwarded","process.nextTick((fn)=>fn(),()=>"+push+");",1],
  ["microtask receives no arguments","queueMicrotask((x="+push+")=>{},'extra');",1],
  ["timeout-less local nextTick","fake.nextTick(()=>"+push+");",0,"const fake={nextTick(fn){}};"],
  ["guard before async disposal",guard+"{await using ticket=resource();}"+push+";",1],
  ["guard after async disposal","{await using ticket=resource();}"+guard+push+";",0],
  ["same resource scope",guard+"{await using ticket=resource();"+push+";}",0],
  ["skipped resource scope",guard+"if(false){await using ticket=resource();}"+push+";",0],
  ["exiting disposal path",guard+"if(req.url){await using ticket=resource();return;}"+push+";",0],
  ["ordinary synchronous disposal",guard+"{using ticket=resource();}"+push+";",0],
  ["async disposal after for-of",guard+"for(await using ticket of [resource()]){}"+push+";",1],
  ["deduplication","if(!jobs.includes(req.url))"+push+";",1],
  ["deduplication with a true limit",guard+"if(!jobs.includes(req.url))"+push+";",0],
  ["telemetry","res.setHeader('head',jobs.at(0));"+push+";",1],
  ["readonly computed member","void jobs['indexOf'](req.url);"+push+";",1],
  ["mutating timer method invalidates reads","void jobs.at(0);"+push+";",0,"Array.prototype.at=function(){this.shift()};"],
  ["actual escape","consume(jobs);"+push+";",0],
  ["while condition","while("+push+"<0){}",1],
  ["for initializer","for(let n="+push+";n<0;n++){}",1],
  ["bounded for initializer",guard+"for(let n="+push+";n<0;n++){}",0],
  ["for incrementor","for(let i=0;i<1;i++,"+push+"){}",1],
  ["unreachable for tail","for(;false;"+push+"){}",0],
  ["do while tail","do{}while("+push+"<0);",1],
  ["skipped do while tail","do{break;}while("+push+"<0);",0],
  ["variable object default","const {id="+push+"}=req;",1],
  ["unused object default","const {id="+push+"}={id:1};",0],
  ["variable array default","const [id="+push+"]=[];",1],
  ["unused nested default","const {info:{id="+push+"}}={info:{id:1}};",0],
  ["evaluated computed key","const {["+push+"]:x}=req;",1],
  ["destructuring after RHS suspension",guard+"const {id="+push+"}=await load(req);",1],
  ["for-of default","for(const {id="+push+"} of [{}]){}",1],
  ["unused for-of default","for(const {id="+push+"} of [{id:1}]){}",0],
  ["unused nested for-of defaults","for(const {row:{id="+push+"}} of [{row:{id:1}},{row:{id:2}}]){}",0],
  ["unentered for-of default","for(const {id="+push+"} of []){}",0],
  ["reserve before awaited payload",counterGuard+"++count;jobs.push(await load(req.url));",0],
  ["scalar reservation","if(count===10)return;++count;jobs.push(await load(req.url));",0],
  ["previous stale reservation",counterGuard+"await load(req);++count;"+push+";",1],
  ["reserve after awaited payload",counterGuard+"jobs.push(await load(req.url));++count;",1],
  ["depth cannot count pending reservations",guard+"++count;jobs.push(await load(req.url));",1],
  ["counter changed outside the queue",counterGuard+"++count;jobs.push(await load(req.url));",1,"function reset(){count=0;}"],
  ["guarded helper reserves before awaiting",counterGuard+"enqueue(req.url);",0,"async function enqueue(x){++count;jobs.push(await load(x));}"],
  ["queue depth cannot cover a helper's in-flight jobs",guard+"enqueue(req.url);",1,"async function enqueue(x){++count;jobs.push(await load(x));}"],
  ["a stale caller cannot cover a helper reservation",counterGuard+"await load();enqueue(req.url);",1,"async function enqueue(x){++count;jobs.push(await load(x));}"],
  ["a second route's depth guard cannot justify its reservation",counterGuard+"enqueue(req.url);",1,
    "async function enqueue(x){++count;jobs.push(await load(x));}createServer(req=>{if(jobs.length>=10)return;enqueue(req.url);});"],
  ["snapshot before suspension","const depth=jobs.length; const alias=depth; await load(); if(alias>=10)return;"+push+";",1],
  ["snapshot before side effects","const depth=jobs.length; const alias=depth; consume(); if(alias>=10)return;"+push+";",1],
]) {
  test(label, async () => assert.equal((await audit(body,{setup})).length,expected));
}

for (const [label, source, expected] of [
  ["const delay","const delay=100; const actual=delay; setInterval(()=>work(jobs.shift()),actual);",1],
  ["mutable delay","let delay=100; setInterval(()=>work(jobs.shift()),delay);",0],
  ["delay in TDZ","setInterval(()=>work(jobs.shift()),delay); const delay=100;",0],
  ["out of range","const delay=0; setInterval(()=>work(jobs.shift()),delay);",0],
]) {
  test(label,async()=>assert.equal((await audit(push+";",{timer:source})).length,expected));
}

test("a wide alias prefix is indexed once across repeated snapshot checks", async () => {
  const n=450;
  const body=["const depth=jobs.length;",...Array.from({length:n},(_,i)=>`const alias${i}=depth;`),
    ...Array.from({length:n},(_,i)=>`if(depth>=${2*n-i})return;`),push+";"].join("\n");
  let units=0;
  const original=AnalysisBudget.prototype.take;
  AnalysisBudget.prototype.take=function(cost=1){if(this.label==="Queue backpressure")units+=cost; return original.call(this,cost);};
  try {
    const report=await audit(body,{inspect:runAudit});
    assert.equal(report.complete,true,JSON.stringify(report.detectors));
    assert.equal(report.findings.filter(f=>f.id==="unbounded-request-queue").length,0);
    assert.ok(units<120_000,`expected shared snapshot lookups, charged ${units} units`);
  } finally { AnalysisBudget.prototype.take=original; }
});

test("a wide for-of pattern shares row facts across evaluated defaults", async () => {
  const size = 450;
  const fields = Array.from({ length: size }, (_, index) => `field${index}=${push}`).join(",");
  const rows = Array.from({ length: size }, () => "{}").join(",");
  const report = await audit(`for(const {${fields}} of [${rows}]){}`, { inspect: runAudit });
  assert.equal(report.complete, true, JSON.stringify(report.detectors));
  assert.equal(report.findings.filter(f => f.id === "unbounded-request-queue").length, 1);
});

test("settled promise reactions from a synchronous burst observe capacity at callback time", async () => {
  async function depthAfterBurst(checkInside) {
    const jobs = [];
    const submissions = [];
    for (let id = 0; id < 100; id++) {
      if (!checkInside && jobs.length >= 10) continue;
      submissions.push(Promise.resolve(id).then(job => {
        if (checkInside && jobs.length >= 10) return;
        jobs.push(job);
      }));
    }
    await Promise.all(submissions);
    return jobs.length;
  }
  assert.equal(await depthAfterBurst(false), 100);
  assert.equal(await depthAfterBurst(true), 10);
});
