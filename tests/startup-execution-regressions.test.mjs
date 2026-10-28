import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {runAudit} from '../dist/runner.js';
import {Workspace} from '../dist/workspace.js';
import {serviceContexts,processEvent} from '../dist/serviceContext.js';

async function fixture(t,files){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-startup-regression-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),JSON.stringify({dependencies:{express:'*'}}));
 for(const[rel,source]of Object.entries(files)){await mkdir(path.dirname(path.join(root,rel)),{recursive:true});await writeFile(path.join(root,rel),source);}
 return root;
}
const server=`import express from 'express';const app=express();`;
const protection=`app.get('/health',()=> 'ok');process.on('SIGTERM',()=>{});`;
const broken={
 'uniterated generator':`function* setup(){${protection}}setup();`,
 'unentered catch':`try{const value=1;}catch(error){${protection}}`,
 'nested unconditional return':`function setup(){if(true)return;${protection}}setup();`,
 'unknown early return':`function setup(){if(enabled)return;${protection}}setup();`,
 'reassigned declaration':`function setup(){${protection}}setup=()=>{};setup();`,
 'throwing helper':`function stop(){throw Error('stop')}stop();${protection}`,
 'recursive helper':`function stop(){stop();}stop();${protection}`,
};
for(const[name,body]of Object.entries(broken))test(`${name} cannot prove startup protection`,async t=>{
 const root=await fixture(t,{'app.ts':server+body+'app.listen(3000);'});const r=await runAudit(root);
 assert.equal(r.complete,true);assert.ok(r.findings.some(f=>f.id==='missing-health-endpoint'));assert.ok(r.findings.some(f=>f.id==='missing-graceful-shutdown'));
});
test('conditional listener remains visible without conditional protection',async t=>{
 const root=await fixture(t,{'app.ts':server+`if(process.env.PORT){app.listen(3000);}`});const r=await runAudit(root);
 assert.equal(r.complete,true);assert.ok(r.findings.some(f=>f.id==='missing-health-endpoint'));assert.ok(r.findings.some(f=>f.id==='missing-graceful-shutdown'));
});
test('statically dead loop does not invent a service',async t=>{
 const root=await fixture(t,{'app.ts':server+'while(false){app.listen(3000)}for(;false;){app.listen(3001)}'});const r=await runAudit(root);
 assert.equal(r.complete,true);assert.ok(!r.findings.some(f=>f.id==='missing-health-endpoint'||f.id==='missing-graceful-shutdown'));
});
test('logical-not reference does not invalidate a callable',async t=>{
 const root=await fixture(t,{'app.ts':server+`function setup(){${protection}}const unused=!setup;setup();app.listen(3000);`});const r=await runAudit(root);
 assert.ok(!r.findings.some(f=>f.id==='missing-health-endpoint'||f.id==='missing-graceful-shutdown'));
});
for(const[suffix,expected]of [['',true],['undefined',true],['123',false]])test(`default registration executes only for omitted/undefined argument: ${suffix}`,async t=>{
 const root=await fixture(t,{'app.ts':`function setup(value=process.on('unhandledRejection',()=>{})){}setup(${suffix});`});
 const ws=await Workspace.load(root);const owner=serviceContexts(root,ws).entryContexts()[0];
 assert.equal([...owner.calls].some(call=>processEvent(call,['unhandledRejection'],owner)),expected);
});
test('called CommonJS import has one protected owner',async t=>{
 const root=await fixture(t,{'main.cjs':`process.on('unhandledRejection',()=>{});function start(){require('./work.cjs')}start();`,'work.cjs':`async function task(){throw Error('x')}task();`});
 const r=await runAudit(root);assert.equal(r.complete,true);assert.ok(!r.findings.some(f=>f.id==='missing-rejection-handler'));
});
test('shared module fan-in reuses local summaries under the unchanged budget',async t=>{
 const files={'shared.ts':Array.from({length:2000},(_,i)=>`export const value${i}=${i};`).join('\n')};
 for(let i=0;i<30;i++)files[`entry${i}.ts`]=`import './shared';export const id=${i};`;
 const root=await fixture(t,files);const r=await runAudit(root);assert.equal(r.complete,true,JSON.stringify(r.detectors));assert.equal(r.coverage.analyzed,31);
});
test('many independent routes use reverse ownership lookup',async t=>{
 const files={};for(let i=0;i<1100;i++)files[`route${i}.ts`]=`export async function GET(){fetch('https://example.com')}`;
 const root=await fixture(t,files);const r=await runAudit(root);assert.equal(r.complete,true,JSON.stringify(r.detectors));assert.equal(r.coverage.analyzed,1100);
});
test('deep called-function expansion still fails explicitly',async t=>{
 const functions=Array.from({length:150},(_,i)=>`function setup${i}(){${i===149?protection:`setup${i+1}()`}}`).join('\n');
 const root=await fixture(t,{'app.ts':server+functions+'setup0();app.listen(3000);'});const r=await runAudit(root);
 assert.equal(r.complete,false);assert.ok(r.detectors.some(d=>d.status==='failed'&&/Startup .* depth limit exceeded/.test(d.reason)));
});

for(const body of [
 `function setup(proc){proc={on(){}};proc.on('unhandledRejection',()=>{})}setup(process);`,
 `function setup(handler){handler=null;process.on('unhandledRejection',handler)}setup(()=>{});`,
 `function setup(flag){flag=false;if(flag)process.on('unhandledRejection',()=>{})}setup(true);`,
 `function setup(a,b=process.on('unhandledRejection',()=>{})){}setup(...[1,2]);`,
])test(`mutated or spread argument does not prove protection: ${body.slice(0,45)}`,async t=>{
 const root=await fixture(t,{'app.ts':body});const ws=await Workspace.load(root);const owner=serviceContexts(root,ws).entryContexts()[0];
 assert.ok(![...owner.calls].some(call=>processEvent(call,['unhandledRejection'],owner)));
});

for(const[awaited,expected]of [[false,true],[true,false]])test(`async rejection ${awaited?'awaited':'unawaited'} has correct caller continuation`,async t=>{
 const root=await fixture(t,{'app.ts':`async function fail(){throw Error('fail')}async function setup(){${awaited?'await ':''}fail();process.on('unhandledRejection',()=>{});}setup();`});
 const ws=await Workspace.load(root);const owner=serviceContexts(root,ws).entryContexts()[0];
 assert.equal([...owner.calls].some(call=>processEvent(call,['unhandledRejection'],owner)),expected);
});
test('try/finally normal completion retains following protective evidence',async t=>{
 const root=await fixture(t,{'app.ts':`try{const value=1;}finally{const clean=true;}process.on('unhandledRejection',()=>{});`});
 const ws=await Workspace.load(root);const owner=serviceContexts(root,ws).entryContexts()[0];
 assert.ok([...owner.calls].some(call=>processEvent(call,['unhandledRejection'],owner)));
});

for(const expression of ['if(stop()){}','stop() && true;'])test(`throwing condition does not prove later protection: ${expression}`,async t=>{
 const root=await fixture(t,{'app.ts':`function stop(){throw Error('stop')}${expression}process.on('unhandledRejection',()=>{});`});
 const ws=await Workspace.load(root);const owner=serviceContexts(root,ws).entryContexts()[0];
 assert.ok(![...owner.calls].some(call=>processEvent(call,['unhandledRejection'],owner)));
});

test('throwing static initialization prevents later protective evidence',async t=>{
 const root=await fixture(t,{'app.ts':`class Setup{static{throw Error('stop')}}process.on('unhandledRejection',()=>{});`});
 const ws=await Workspace.load(root);const owner=serviceContexts(root,ws).entryContexts()[0];
 assert.ok(![...owner.calls].some(call=>processEvent(call,['unhandledRejection'],owner)));
});

test('listener-relative protection survives a shared guarded startup prefix',async t=>{
 const root=await fixture(t,{'app.ts':`${server}function configure(){if(invalid)throw Error('invalid');return 1;}if(isMain){const port=Number(process.env.PORT??8787);const config=configure();app.listen(port);process.on('SIGTERM',()=>{});}`});
 const r=await runAudit(root);assert.equal(r.complete,true);assert.ok(!r.findings.some(f=>f.id==='missing-graceful-shutdown'));
});
test('aborting operation between listener and registration prevents relative proof',async t=>{
 const root=await fixture(t,{'app.ts':`${server}function stop(){throw Error('stop')}if(isMain){app.listen(3000);stop();process.on('SIGTERM',()=>{});}`});
 const r=await runAudit(root);assert.equal(r.complete,true);assert.ok(r.findings.some(f=>f.id==='missing-graceful-shutdown'));
});
