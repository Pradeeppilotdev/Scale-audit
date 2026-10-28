import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';
const setup=`app.get('/health',()=> 'ok');process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{});`;
const ids=new Set(['missing-health-endpoint','missing-graceful-shutdown','missing-rejection-handler']);
async function findings(t,files){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-three-gap-integration-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 for(const[name,source]of Object.entries(files))await writeFile(path.join(root,name),source);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.filter(finding=>ids.has(finding.id));
}
const cjs={
 'package.json':'{"type":"commonjs","dependencies":{"express":"*"}}',
 'bad.cjs':`throw Error('failed');`,
};
const cjsHead=`const express=require('express');const app=express();async function work(){throw Error()}`;
test('setup before a caught throwing require remains valid helper prefix',async t=>{
 const result=await findings(t,{...cjs,'main.cts':cjsHead+`function install(){${setup}require('./bad.cjs')}try{install()}catch{}app.listen(3000);work();`});
 assert.equal(result.length,0);
});
test('caught require failure drops helper setup while retaining independent parent health',async t=>{
 const result=await findings(t,{...cjs,'main.cts':cjsHead+`function install(){require('./bad.cjs');${setup}}try{install()}catch{}app.get('/health',()=> 'ok');app.listen(3000);work();`});
 assert.deepEqual(result.map(f=>f.id).sort(),['missing-graceful-shutdown','missing-rejection-handler']);
});
test('an import cycle inside a caught helper cannot donate unreachable completion',async t=>{
 const result=await findings(t,{
  'package.json':'{"type":"module","dependencies":{"express":"*"}}',
  'app.ts':`import express from 'express';export const app=express();`,
  'main.ts':`import{app}from './app.js';async function work(){throw Error()}await import('./a.js');app.listen(3000);work();`,
  'a.ts':`import{app}from './app.js';async function install(){await import('./b.js');${setup}}try{await install()}catch{}`,
  'b.ts':`await import('./a.js');`,
 });
 assert.equal(result.length,3);
});
