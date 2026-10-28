import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';
import {Workspace} from '../dist/workspace.js';
import {ServiceContexts} from '../dist/serviceContext.js';
const handlers=`process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{});`;
const main=`const express=require('express');const app=express();async function work(){throw Error()}`;
const tail=`app.get('/health',()=> 'ok');app.listen(3000);work();`;
async function fixture(t,files){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-release-require-order-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),'{"type":"commonjs","dependencies":{"express":"*"}}');
 for(const[name,source]of Object.entries(files))await writeFile(path.join(root,name),source);
 return root;
}
async function lifecycle(root){
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.filter(f=>['missing-health-endpoint','missing-graceful-shutdown','missing-rejection-handler'].includes(f.id));
}
test('execution-ordered require scheduling retains actual prethrow module handlers',async t=>{
 const root=await fixture(t,{
  'main.cts':main+`try{require('./zbad.cjs')}catch{}function setup(){require('./zzleaf.cjs')}try{setup()}catch{}`+tail,
  'zbad.cjs':handlers+`require('./bad.cjs');require('./zzleaf.cjs');`,
  'bad.cjs':`throw Error('failed');`,
  'zzleaf.cjs':`require('./zbad.cjs');`,
 });
 assert.equal((await lifecycle(root)).length,0);
});
test('genuine reached CommonJS cycles retain their safe prefix and completion',async t=>{
 const root=await fixture(t,{
  'main.cts':main+`require('./a.cjs');`+tail,
  'a.cjs':`process.on('SIGTERM',()=>{});require('./b.cjs');process.on('unhandledRejection',()=>{});`,
  'b.cjs':`require('./a.cjs');`,
 });
 assert.equal((await lifecycle(root)).length,0);
});
test('internal require scheduling requests do not poison repeated public context access',async t=>{
 const root=await fixture(t,{'main.cts':main+`require('./a.cjs');`+tail,'a.cjs':`require('./b.cjs');`,'b.cjs':handlers});
 const workspace=await Workspace.load(root);const context=new ServiceContexts(root,workspace);
 const entries=context.entryContexts();assert.ok(entries.length>0);
 assert.equal(context.entryContexts(),entries);
 const source=workspace.units.find(unit=>unit.rel==='main.cts').sf;
 assert.equal(context.startup(source),entries[0]);
 assert.equal((await lifecycle(root)).length,0);
});
