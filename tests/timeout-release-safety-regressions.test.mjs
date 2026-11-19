import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import ts from "typescript";
import { runAudit } from "../dist/runner.js";
import { detectOutboundTimeouts } from "../dist/detectors/outboundTimeout.js";
import { nativeAbortSignalUnchanged } from "../dist/nativeSignals.js";
import { AnalysisBudget, AnalysisLimitError } from "../dist/analysisBudget.js";
import { Workspace } from "../dist/workspace.js";
import { planCodemod } from "../dist/codemod.js";

async function fixture(t, source, extension = "ts", files = {}) {
  const root = await mkdtemp(join(tmpdir(), "scale-timeout-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const name = `route.${extension}`;
  await writeFile(join(root, name), source);
  for (const [file, text] of Object.entries(files)) await writeFile(join(root, file), text);
  return { root, name };
}
const timeouts = report => report.findings.filter(finding => finding.id === "outbound-no-timeout");
const signalCall = signal => `export function GET() {\n return fetch('https://example.test', {signal: ${signal}});\n}`;
const mutations = [
  "AbortSignal.timeout=()=>new AbortController().signal;",
  "AbortSignal['timeout']=()=>new AbortController().signal;",
  "globalThis.AbortSignal={timeout:()=>new AbortController().signal};",
  "globalThis.globalThis.AbortSignal.timeout=replacement;",
  "globalThis['globalThis']['AbortSignal']=replacement;",
  "global.AbortSignal.timeout=replacement;",
  "const factory=AbortSignal;factory.timeout=replacement;",
  "const host=globalThis;host.AbortSignal=replacement;",
  "const {AbortSignal:factory}=globalThis;factory.timeout=replacement;",
  "Object.assign(AbortSignal,{timeout:replacement});",
  "Object.defineProperty(AbortSignal,'timeout',{value:replacement});",
  "Reflect.defineProperty(globalThis,'AbortSignal',{value:replacement});",
  "globalThis.__defineGetter__('AbortSignal',()=>replacement);",
  "({timeout:AbortSignal.timeout}=replacement);",
  "[AbortSignal.timeout]=replacement;",
  "function patch(){AbortSignal.timeout=replacement;}",
];
for (const extension of ["ts", "js"]) for (const mutation of mutations) {
  for (const signal of ["AbortSignal.timeout(5000)", "globalThis.AbortSignal.timeout(5000)", "AbortSignal.any([controller.signal,AbortSignal.timeout(5000)])"]) {
    test(`${extension} timer proof rejects mutation: ${mutation} via ${signal}`, async t => {
      const {root} = await fixture(t, `${mutation}\n${signalCall(signal)}`, extension);
      const findings = await detectOutboundTimeouts(root);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].confidence, "low");
    });
  }
}
for (const extension of ["ts", "js"]) for (const setup of [
  "", "globalThis.cache=new Map();", "AbortSignal.timeout(20);", "globalThis.AbortSignal.abort();",
  "function local(AbortSignal){AbortSignal.timeout=replacement;}",
  "function local(globalThis){globalThis.AbortSignal=replacement;}",
  "const local={AbortSignal:replacement, get globalThis(){return 1;}};",
  "const {AbortSignal:local}=options;",
  "import {AbortSignal as local} from 'other';",
  "const local={};export {local as AbortSignal};",
  "if(typeof AbortSignal==='undefined')throw new Error('unsupported');",
  "const supported=typeof AbortSignal.timeout==='function';",
  "const supported=typeof globalThis.AbortSignal.timeout==='function';",
  "const exists='AbortSignal' in globalThis;",
  "const exists='timeout' in AbortSignal;",
]) {
  test(`${extension} unchanged timer proof retains local shadow/read control: ${setup}`, async t => {
    const {root} = await fixture(t, `${setup}\n${signalCall("AbortSignal.timeout(5000)")}`, extension);
    assert.deepEqual(await detectOutboundTimeouts(root), []);
  });
}
for (const extension of ["ts", "js"]) test(`${extension} feature checks do not hide later timer mutation`, async t => {
  const source=`const supported=typeof AbortSignal.timeout==='function';const exists='AbortSignal' in globalThis;\nAbortSignal.timeout=replacement;\n${signalCall("AbortSignal.timeout(5000)")}`;
  const {root}=await fixture(t,source,extension);
  const findings=await detectOutboundTimeouts(root);
  assert.equal(findings.length,1);
  assert.equal(findings[0].confidence,"low");
});
for (const extension of ["js", "ts"]) for (const mutation of mutations.slice(0, 6)) {
  test(`a ${extension} sibling mutation invalidates timer proof and safe insertions: ${mutation}`, async t => {
    const source = `import './patch.${extension}';\n${signalCall("AbortSignal.timeout(5000)")}\nexport function POST(){\n return fetch('https://example.test');\n}`;
    const {root, name} = await fixture(t, source, "ts", {[`patch.${extension}`]: mutation});
    const report = await runAudit(root, {codemod: "apply"});
    assert.equal(report.complete, true);
    assert.equal(timeouts(report).length, 2);
    assert.equal(report.codemod.applied, false);
    assert.equal(await readFile(join(root, name), "utf8"), source);
  });
}

test("a replaced native timer really leaves the request signal without a deadline", async () => {
  let observed;
  const context = {AbortController, AbortSignal: {timeout: AbortSignal.timeout.bind(AbortSignal)}, fetch: (_url, options) => { observed = options.signal; }};
  vm.runInNewContext("AbortSignal.timeout=()=>new AbortController().signal;fetch('local',{signal:AbortSignal.timeout(0)});", context);
  const native = AbortSignal.timeout(0);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(native.aborted, true);
  assert.equal(observed.aborted, false);
});

const localFetch = "(url,options)=>{if(options)throw new Error('unexpected options');return 'ok'}";
const localAxios = "{get(url,options){if(options)throw new Error('unexpected options');return 'ok'}}";
for (const extension of ["js", "ts"]) for (const kind of ["fetch", "axios"]) {
  const header = kind === "fetch" ? "import nativeFetch from 'node-fetch';" : "import axios from 'axios';";
  const native = kind === "fetch" ? "nativeFetch" : "axios";
  const local = kind === "fetch" ? localFetch : localAxios;
  const invoke = kind === "fetch" ? "request('https://example.test')" : "request.get('https://example.test')";
  for (const [name, setup, expected] of [
    ["replaced", `let request=${native};request=${local};`, 0],
    ["restored", `let request=${local};request=${native};`, 1],
    ["captured native", `let selected=${native};const request=selected;selected=${local};`, 1],
    ["captured local", `let selected=${local};const request=selected;selected=${native};`, 0],
  ]) {
    test(`${extension} ${kind} timeout fixes follow ${name} identity`, async t => {
      const source = `${header}\n${setup}\nexport function GET(){\n return ${invoke};\n}`;
      const {root, name:file} = await fixture(t, source, extension);
      const report = await runAudit(root, {codemod: "apply"});
      assert.equal(report.complete, true);
      assert.equal(timeouts(report).length, expected);
      assert.equal(report.codemod.appliedEdits, expected);
      const after = await readFile(join(root,file),"utf8");
      if (!expected) {
        assert.equal(after, source);
        const code = after.replace(/^import[^;]+;/, "").replaceAll("export ", "") + ";GET();";
        assert.equal(vm.runInNewContext(code, {nativeFetch:()=>"native", axios:{get:()=>"native"}, AbortSignal}), "ok");
      }
    });
  }
}

for (const [label, source] of [
  ["axios method", `import axios from 'axios';axios.get=${localFetch};\nexport function GET(){return axios.get('https://example.test');}`],
  ["undici member", `import * as undici from 'undici';undici.fetch=${localFetch};\nexport function GET(){return undici.fetch('https://example.test');}`],
  ["captured axios object", `import axios from 'axios';const request=axios;request.get=${localFetch};\nexport function GET(){return axios.get('https://example.test');}`],
]) {
  test(`replaced ${label} cannot receive a native timeout edit`, async t => {
    const {root,name} = await fixture(t,source);
    const report = await runAudit(root,{codemod:"apply"});
    assert.equal(report.complete,true);
    assert.equal(timeouts(report).length,0);
    assert.equal(report.codemod.applied,false);
    assert.equal(await readFile(join(root,name),"utf8"),source);
  });
}
for (const [property, native, args, expected] of [
  ["get","post","'https://example.test',{timeout:5000}",1],
  ["get","post","'https://example.test',{}, {timeout:5000}",0],
  ["post","get","'https://example.test',{timeout:5000}",0],
  ["post","get","'https://example.test'",1],
]) test(`Axios ${property} assigned ${native} keeps the actual argument signature: ${args}`, async t => {
  const source=`import axios from 'axios';axios.${property}=axios.${native};\nexport function GET(){\n return axios.${property}(${args});\n}`;
  const {root,name}=await fixture(t,source);
  const report=await runAudit(root,{codemod:"apply"});
  assert.equal(report.complete,true);
  assert.equal(timeouts(report).length,expected);
  assert.equal(report.codemod.appliedEdits,expected);
  const after=await readFile(join(root,name),"utf8");
  const observed=[];
  const axios={get:(url,config)=>observed.push({url,config}),post:(url,body,config)=>observed.push({url,body,config})};
  vm.runInNewContext(after.replace(/^import[^;]+;/,"").replaceAll("export ","")+";GET();",{axios});
  assert.equal(observed[0].config.timeout,5000);
  if(native==="post"&&args.includes("{timeout:5000}")) assert.equal(observed[0].body.timeout,expected ? 5000 : undefined);
});
for (const [label, setup, expected] of [
  ["replaced", `let request=nativeFetch;request=${localFetch};`, 0],
  ["restored", `let request=${localFetch};request=nativeFetch;`, 1],
]) {
  test(`cross-file ${label} HTTP aliases retain current identity`, async t => {
    const source="import {request} from './bridge.js';\nexport function GET(){return request('https://example.test');}";
    const bridge=`import nativeFetch from 'node-fetch';${setup}export {request};`;
    const {root} = await fixture(t,source,"ts",{"bridge.js":bridge});
    const report=await runAudit(root);
    assert.equal(report.complete,true);
    assert.equal(timeouts(report).length,expected);
  });
}

for (const extension of ["js", "ts"]) for (const kind of ["fetch", "axios"]) {
  test(`a ${extension} sibling global ${kind} replacement keeps HTTP edits manual`, async t => {
    const mutation = kind === "fetch" ? `globalThis.fetch=${localFetch};` : `globalThis.axios=${localAxios};`;
    const call = kind === "fetch" ? "fetch('https://example.test')" : "axios.get('https://example.test')";
    const source=`import './patch.${extension}';\nexport function GET(){\n return ${call};\n}`;
    const {root,name}=await fixture(t,source,"ts",{[`patch.${extension}`]:mutation});
    const report=await runAudit(root,{codemod:"apply"});
    assert.equal(report.complete,true);
    assert.equal(report.codemod.applied,false);
    assert.equal(await readFile(join(root,name),"utf8"),source);
    const workspace=await Workspace.load(root);
    const sources=function*(){for(const unit of workspace.units)yield unit.sf;};
    const plan=planCodemod(root,report.findings,sources());
    assert.equal(plan.patched,0,"a one-use source iterable must be retained for every global safety check");
  });
}

for (const mutation of [
  `globalThis.fetch=${localFetch};`, `fetch=${localFetch};`,
  `globalThis.globalThis.fetch=${localFetch};`,
]) test(`a visibly replaced global fetch receives no timeout insertion: ${mutation}`, async t => {
  const source=`${mutation}\nexport function GET(){\n return fetch('https://example.test');\n}`;
  const {root,name}=await fixture(t,source);
  const report=await runAudit(root,{codemod:"apply"});
  assert.equal(report.complete,true);
  assert.equal(report.codemod.applied,false);
  assert.equal(await readFile(join(root,name),"utf8"),source);
});

test("native timer identity scans are shared and grow linearly", () => {
  const work=[];
  const take=AnalysisBudget.prototype.take;
  try {
    for(const size of [400,800]) {
      let charged=0;
      AnalysisBudget.prototype.take=function(units=1){if(this.label==="Native timer identity")charged+=units;return take.call(this,units);};
      const sf=ts.createSourceFile("route.ts","AbortSignal.timeout(5);".repeat(size),ts.ScriptTarget.Latest,true);
      assert.equal(nativeAbortSignalUnchanged(sf),true);
      const first=charged;
      for(let i=0;i<size;i++)assert.equal(nativeAbortSignalUnchanged(sf),true);
      assert.equal(charged,first,"completed facts must not rescan the source");
      work.push(charged);
    }
  } finally {AnalysisBudget.prototype.take=take;}
  assert.ok(work[1]<work[0]*2.2,`expected linear work, got ${work}`);
});
test("native timer scan failures cannot publish or reuse partial proof", () => {
  const sf=ts.createSourceFile("route.ts","AbortSignal.timeout(5);".repeat(20),ts.ScriptTarget.Latest,true);
  const take=AnalysisBudget.prototype.take;
  const failure=new AnalysisLimitError("Native timer identity analysis work budget exceeded");
  let charged=0;
  try {
    AnalysisBudget.prototype.take=function(units=1){if(this.label==="Native timer identity"&&(charged+=units)>12)throw failure;return take.call(this,units);};
    assert.throws(()=>nativeAbortSignalUnchanged(sf),error=>error===failure);
  } finally {AnalysisBudget.prototype.take=take;}
  assert.throws(()=>nativeAbortSignalUnchanged(sf),error=>error===failure);
});
for (const codemod of [undefined,"diff","apply"]) test(`native timer work exhaustion keeps ${codemod ?? "plain"} audits incomplete`, async t => {
  const source=signalCall("AbortSignal.timeout(5000)")+"\nexport function POST(){return fetch('https://example.test');}";
  const {root,name}=await fixture(t,source);
  const take=AnalysisBudget.prototype.take;
  try {
    AnalysisBudget.prototype.take=function(units=1){if(this.label==="Native timer identity")throw new AnalysisLimitError("Native timer identity analysis work budget exceeded");return take.call(this,units);};
    const report=await runAudit(root,{codemod});
    assert.equal(report.complete,false);
    assert.ok(report.detectors.some(detector=>detector.name==="detectOutboundTimeouts"&&detector.status==="failed"&&/Native timer identity/.test(detector.reason)));
    if(codemod)assert.equal(report.codemod.applied,false);
    assert.equal(await readFile(join(root,name),"utf8"),source);
  } finally {AnalysisBudget.prototype.take=take;}
});
