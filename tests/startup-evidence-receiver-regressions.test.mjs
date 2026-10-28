import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';
const head=`import express from 'express';const app=express();`;
const protect=`process.on('SIGTERM',()=>{});app.get('/health',()=> 'ok');`;
const setup=`async function setup(){await load();${protect}}`;
async function audit(t,body,files={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-startup-evidence-receiver-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),JSON.stringify({type:'module',dependencies:{express:'*'}}));
 for(const [name,source]of Object.entries({'main.ts':head+body,...files}))await writeFile(path.join(root,name),source);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.filter(f=>['missing-health-endpoint','missing-graceful-shutdown'].includes(f.id));
}
for(const barrier of [
 `import type {Foo}from './types';`,
 `import {type Foo}from './types';`,
 `export type {Foo}from './types';`,
 `import './side-effect';`,
 `class Empty{}`,
 `class Deferred{method(){throw Error('not called')}field=throwLater()}`,
])test('completed startup evidence crosses harmless declaration: '+barrier,async t=>{
 assert.equal((await audit(t,setup+`await setup();${barrier}app.listen(3000);`,{'types.ts':'export type Foo=string;','side-effect.ts':'export const marker=1;'})).length,0);
});
for(const body of [
 `class Ready{static{${protect}}}`,
 `class Ready{static signal=process.on('SIGTERM',()=>{});static route=app.get('/health',()=> 'ok')}`,
 `class Base{}class Ready extends (process.on('SIGTERM',()=>{}),Base){[app.get('/health',()=> 'ok')](){}}`,
])test('executed class portions provide reached startup evidence: '+body.slice(0,85),async t=>{
 assert.equal((await audit(t,`await load();${body}app.listen(3000);`)).length,0);
});
test('deferred instance fields and methods cannot establish startup evidence',async t=>{
 assert.equal((await audit(t,`await load();class Deferred{field=process.on('SIGTERM',()=>{});method(){app.get('/health',()=> 'ok')}}app.listen(3000);`)).length,2);
});
test('conditional static setup cannot become unconditional protection',async t=>{
 assert.equal((await audit(t,`await load();declare const enabled:boolean;class Ready{static{if(enabled){${protect}}}}app.listen(3000);`)).length,2);
});
test('static setup following an earlier listener cannot backfill across await',async t=>{
 const findings=await audit(t,`app.listen(3000);await load();class Ready{static{${protect}}}`);
 assert.equal(findings.length,2);
});
for(const receiver of [
 `(process.on('SIGTERM',()=>{}),maybe)?.()`,
 `(process.on('SIGTERM',()=>{}),maybe)?.method()`,
 `(process.on('SIGTERM',()=>{}),maybe)?.property[ignored()]()`,
 `(process.on('SIGTERM',()=>{}),maybe)?.method?.()`,
])test('optional receiver evaluates unconditional registration: '+receiver,async t=>{
 const findings=await audit(t,`await load();declare const maybe:any;${receiver};app.get('/health',()=> 'ok');app.listen(3000);`);
 assert.equal(findings.length,0);
});
for(const guarded of [
 `maybe?.(process.on('SIGTERM',()=>{}))`,
 `maybe?.[process.on('SIGTERM',()=>{})]()`,
 `maybe?.property[process.on('SIGTERM',()=>{})]()`,
 `maybe?.[process.on('SIGTERM',()=>{})]?.()`,
])test('optional arguments and keys remain conditional: '+guarded,async t=>{
 const findings=await audit(t,`await load();declare const maybe:any;${guarded};app.get('/health',()=> 'ok');app.listen(3000);`);
 assert.ok(findings.some(f=>f.id==='missing-graceful-shutdown'));
});
