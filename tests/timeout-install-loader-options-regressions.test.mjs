import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { AnalysisBudget } from '../dist/analysisBudget.js';
import { detectOutboundTimeouts } from '../dist/detectors/outboundTimeout.js';
import { runAudit } from '../dist/runner.js';

const fakeAxios = `const hooks = [];
const client = { interceptors:{request:{use:f=>hooks.push(f)},response:{use(){}}},
  get:(url,config={})=>send('get',null,config), post:(url,body,config={})=>send('post',body,config) };
function send(method,body,config){for(const hook of hooks)config=hook(config);return {method,body,timeout:config.timeout||0};}
module.exports=client;`;
const dependency = 'node_modules/axios/index.js';
const rootPackage = {name:'@review/service',type:'module'};
const swap = "const client=require('axios');client.get=client.post;";
const esmSwap = "import client from 'axios';client.get=client.post;";
const route = (setup='', call="client.get('/health',{id:123})") =>
  `import client from 'axios';\n${setup}\nexport function GET(){\n return ${call};\n}`;
const timeouts = (report,file) => report.findings.filter(f=>f.id==='outbound-no-timeout' && (!file || f.file===file));

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(),'scale-timeout-proof-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const [name,content] of Object.entries(files)){
    await mkdir(join(root,dirname(name)),{recursive:true}); await writeFile(join(root,name),content);
  }
  return root;
}
function observe(root) {
  const p=spawnSync(process.execPath,['--input-type=module','-e',"import {GET} from './route.mjs';console.log(JSON.stringify(GET()));"],{cwd:root,encoding:'utf8'});
  assert.equal(p.status,0,p.stderr);
  return JSON.parse(p.stdout);
}

for(const separate of [false,true])test(`different package search paths preserve POST data, separate install = ${separate}`,async t=>{
  const root=await fixture(t,{[dependency]:fakeAxios,'setup/patch.mjs':"import client from 'axios';client.post=client.get;",
    'route.mjs':route("import './setup/patch.mjs';","client.post('/health',{id:123})"),...(separate?{['setup/'+dependency]:fakeAxios}:{})});
  const before=observe(root);
  const r=await runAudit(root,{codemod:'apply'});
  assert.equal(r.complete,true);
  assert.equal(r.codemod.appliedEdits,0);
  assert.equal(timeouts(r,'route.mjs')[0]?.confidence,'low');
  assert.deepEqual(observe(root),before);
  assert.equal(before.method,separate?'post':'get');
  assert.deepEqual(before.body,separate?{id:123}:null);
});

for(const [name,setup] of [
  ['module.require',"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);const module=require('node:module');require('./bootstrap.cjs');"],
  ['named createRequire',"import {createRequire as make} from 'node:module';const load=make(import.meta.url);load('./setup.cjs');"],
  ['a loader alias',"import {createRequire} from 'node:module';const load=createRequire(import.meta.url);const linked=load;linked('./setup.cjs');"],
])for(const single of [false,true])test(`${name} preserves payload in ${single?'file':'folder'} mode`,async t=>{
  const root=await fixture(t,{[dependency]:fakeAxios,'package.json':JSON.stringify(rootPackage),'setup.cjs':swap,
    'bootstrap.cjs':"module.require('./setup.cjs');",'route.mjs':route(setup)});
  const before=observe(root);
  const r=await runAudit(single?join(root,'route.mjs'):root,{codemod:'apply'});
  assert.equal(r.complete,true);assert.equal(r.codemod.appliedEdits,0);
  assert.deepEqual(before,{method:'post',body:{id:123},timeout:0});
  assert.deepEqual(observe(root),before);
});

for(const [label,entry,files,patches] of [
  ['exact self export',"import '@review/service/bootstrap';",{'package.json':JSON.stringify({...rootPackage,exports:{'./bootstrap':'./setup.mjs'}}),'setup.mjs':esmSwap},1],
  ['conditional self export',"import '@review/service/bootstrap';",{'package.json':JSON.stringify({...rootPackage,exports:{'./bootstrap':{import:'./setup.mjs'}}}),'setup.mjs':esmSwap},0],
  ['explicit executable sibling',"import './setup.mjs';",{'setup.mjs':esmSwap,'setup.mts':'export {};'},1],
  ['loader with a different base',"import {createRequire} from 'node:module';const load=createRequire(new URL('./child/base.cjs',import.meta.url));load('./setup.cjs');",{'child/setup.cjs':swap,'setup.cjs':'module.exports={};'},0],
])test(`${label} retains the actual request body`,async t=>{
  const root=await fixture(t,{[dependency]:fakeAxios,'route.mjs':route(entry),...files});
  const before=observe(root),r=await runAudit(root,{codemod:'apply'}), after=observe(root);
  assert.equal(r.complete,true);assert.equal(r.codemod.appliedEdits,patches);
  assert.deepEqual(before,{method:'post',body:{id:123},timeout:0});
  assert.deepEqual(after,{...before,timeout:patches?5000:0});
});

test('runtime import-equals and ambiguous executable TS inputs keep timeout edits manual',async t=>{
  const root=await fixture(t,{'setup.cjs':swap,'setup.cts':'export const installed=true;',
    'route.cts':"import config = require('./setup.cjs');\nconst client=require('axios');\nvoid config.installed;\nexports.GET=()=>client.get('/health',{id:123});"});
  const r=await runAudit(root,{codemod:'diff'});assert.equal(r.complete,true);assert.equal(r.codemod.patched,0);
});
test('import-equals establishes a runtime link even without a TS sibling',async t=>{
  const root=await fixture(t,{'setup.cjs':swap,
    'route.cts':"import config = require('./setup.cjs');\nimport client = require('axios');\nvoid config.installed;\nexport function GET(){\n return client.get('/health',{id:123});\n}"});
  const r=await runAudit(root,{codemod:'apply'});assert.equal(r.complete,true);assert.equal(r.codemod.appliedEdits,0);
  assert.match(await readFile(join(root,'route.cts'),'utf8'),/get\('\/health',\{id:123\}\)/);
});

for(const [label,setup,patches,deadline] of [
  ['a request interceptor',"client.interceptors.request.use(c=>{c.timeout ||= 250;return c;});",0,250],
  ['captured request manager',"const hooks=client.interceptors.request;hooks.use(c=>{c.timeout ||= 250;return c;});",0,250],
  ['destructured interceptor managers',"const {interceptors:hooks}=client;hooks.request.use(c=>{c.timeout ||= 250;return c;});",0,250],
  ['nested destructured request manager',"const {interceptors:{request:hooks}}=client;hooks.use(c=>{c.timeout ||= 250;return c;});",0,250],
  ['destructuring assignment',"let hooks;({interceptors:hooks}=client);hooks.request.use(c=>{c.timeout ||= 250;return c;});",0,250],
  ['interceptors included in rest',"const {post,...rest}=client;rest.interceptors.request.use(c=>{c.timeout ||= 250;return c;});",0,250],
  ['computed destructuring',"const key='interceptors';const {[key]:hooks}=client;hooks.request.use(c=>{c.timeout ||= 250;return c;});",0,250],
  ['destructured response manager',"const {interceptors:{response:hooks},...rest}=client;hooks.use(x=>x);",1,5000],
  ['response-only interceptor',"client.interceptors.response.use(x=>x);",1,5000],
  ['different object',"const unused={interceptors:{request:{use(){}}}};unused.interceptors.request.use(c=>c);",1,5000],
])test(`${label} gives the intended effective deadline`,async t=>{
  const root=await fixture(t,{[dependency]:fakeAxios,'route.mjs':route(setup,"client.get('/health')")});
  const r=await runAudit(root,{codemod:'apply'});assert.equal(r.complete,true);
  assert.equal(r.codemod.appliedEdits,patches);
  assert.equal(observe(root).timeout,deadline);
});
test('linked setup can register a request interceptor',async t=>{
  const root=await fixture(t,{[dependency]:fakeAxios,'setup.mjs':"import client from 'axios';client.interceptors.request.use(c=>({...c,timeout:c.timeout||250}));",
    'route.mjs':route("import './setup.mjs';","client.get('/health')")});
  const r=await runAudit(root,{codemod:'apply'});assert.equal(r.complete,true);
  assert.equal(r.codemod.appliedEdits,0);assert.equal(observe(root).timeout,250);
});

test('child and grandchild clients use creation-time defaults with explicit overrides',async t=>{
  const lines=["import client from 'axios';","const parent=client.create({timeout:250});","const child=parent.create();",
    "const bounded=child.create({timeout:800});","const off=bounded.create({timeout:0});",
    "child.get('/child');","bounded.get('/bounded');","off.get('/off');","off.get('/on',{timeout:50});",
    "parent.get('/off',{timeout:0});","client.get('/root');"];
  const root=await fixture(t,{'route.mjs':lines.join('\n')});
  const r=await runAudit(root);assert.equal(r.complete,true);
  assert.deepEqual(timeouts(r).map(f=>f.line).sort((a,b)=>a-b),[8,10,11]);
});

test('native Request deadlines survive wrapping and aliases until the call overrides the signal',async t=>{
  const source=["const req=new globalThis.Request('data:text/plain,ok',{signal:AbortSignal.timeout(2)});",
    "const alias=req;","const cloned=new Request(alias);",
    "fetch(req);","fetch(alias,{method:'GET'});","fetch(cloned,{signal:undefined});",
    "fetch(req,{signal:null});","fetch(req,{__proto__:{signal:null}});",
    "function custom(Request){ const req=new Request('x',{signal:AbortSignal.timeout(2)});return fetch(req);}",
    "fetch('data:text/plain,ok');"].join('\n');
  const root=await fixture(t,{'route.mjs':source});
  const r=await runAudit(root);assert.equal(r.complete,true);
  assert.deepEqual(timeouts(r).map(f=>f.line).sort((a,b)=>a-b),[7,8,9,10]);
});
test('a replacement native Request cannot establish a deadline',async t=>{
  const root=await fixture(t,{'patch.mjs':"globalThis.Request=class {constructor(){} };",
    'route.mjs':"import './patch.mjs';const req=new Request('x',{signal:AbortSignal.timeout(5)});fetch(req);"});
  const r=await runAudit(root);assert.equal(r.complete,true);assert.equal(timeouts(r).length,1);
});

test('shared Axios options and parent factories consume linear work as call sites grow',async t=>{
  const used=[];
  for(const n of [400,800]){
    const options=Array.from({length:n},(_,i)=>'key'+i+':1');
    const repeats=Array.from({length:n},(_,i)=>"api.get('/"+i+"');");
    const root=await fixture(t,{'route.mjs':["import client from 'axios';",
      `const parent=client.create({${options.join(',')},timeout:250});`,"const api=parent.create();",...repeats,"api.get('/unbounded',{timeout:0});"].join('\n')});
    const take=AnalysisBudget.prototype.take;let work=0;
    try{
      AnalysisBudget.prototype.take=function(units=1){if(this.label==='Outbound timeout options')work+=units;return take.call(this,units);};
      const findings=await detectOutboundTimeouts(root);
      assert.equal(findings.length,1);
    }finally{AnalysisBudget.prototype.take=take;}
    assert.ok(work>=n && work<6*n, String(work));used.push(work);
  }
  assert.ok(used[1]<used[0]*2.1,String(used));
});

test('import and require may select different client objects in the same directory',async t=>{
  const root=await fixture(t,{
    'node_modules/axios/package.json':JSON.stringify({name:'axios',exports:{import:'./esm.mjs',require:'./common.cjs'}}),
    'node_modules/axios/esm.mjs':fakeAxios.replace('module.exports=client','export default client'),
    'node_modules/axios/common.cjs':fakeAxios,
    'route.mjs':route("import {createRequire} from 'node:module';const require=createRequire(import.meta.url);const other=require('axios');other.post=other.get;",
      "client.post('/health',{id:123})")
  });
  const before=observe(root);
  const r=await runAudit(root,{codemod:'apply'});
  assert.equal(r.complete,true);
  assert.deepEqual(before,{method:'post',body:{id:123},timeout:0});
  assert.deepEqual(observe(root),before);
  assert.equal(timeouts(r)[0]?.confidence,'low');
  assert.equal(r.codemod.appliedEdits,0);
});

test('outbound findings retain distinct columns while an ambiguous edit remains manual',async t=>{
  const source="export function GET(){fetch('/one');fetch('/two');}";
  const root=await fixture(t,{'route.mjs':source});
  const r=await runAudit(root,{codemod:'apply'});
  assert.equal(r.complete,true);
  assert.deepEqual(timeouts(r).map(f=>f.column).sort((a,b)=>a-b),[source.indexOf('fetch')+1,source.lastIndexOf('fetch')+1]);
  assert.equal(r.codemod.appliedEdits,0);
  assert.equal(await readFile(join(root,'route.mjs'),'utf8'),source);
});
