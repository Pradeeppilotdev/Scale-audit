import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

async function audit(t,leaf){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-require-order-validation-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const setup=`app.get('/health',()=>{});process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{});`;
 const files={
  'package.json':'{"type":"commonjs","dependencies":{"express":"*"}}',
  'main.cts':`const express=require('express');const app=express();async function work(){throw Error()}try{require('./zbad.cjs')}catch{}function install(){require('./zzleaf.cjs');${setup}}try{install()}catch{}app.listen(3000);work();`,
  'bad.cjs':leaf,
  'zbad.cjs':`require('./bad.cjs');require('./zzleaf.cjs');`,
  'zzleaf.cjs':`require('./zbad.cjs');`,
 };
 for(const[name,source]of Object.entries(files))await writeFile(path.join(root,name),source);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.filter(f=>['missing-health-endpoint','missing-graceful-shutdown','missing-rejection-handler'].includes(f.id));
}
test('a throwing require prevents unreachable later dependencies from manufacturing partial exports',async t=>{
 assert.equal((await audit(t,`throw Error();`)).length,3);
});
test('a completed prerequisite retains a genuinely reached CommonJS partial-export cycle',async t=>{
 assert.equal((await audit(t,`exports.ready=true;`)).length,0);
});
test('wide ordinary require fanout reuses completed statement prefixes within existing work limits',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-require-fanout-validation-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),'{"type":"commonjs","dependencies":{"express":"*"}}');
 let source=`const express=require('express');const app=express();`;
 for(let index=0;index<500;index++){
  await writeFile(path.join(root,`z${index}.cjs`),`exports.value=${index};`);
  source+=`require('./z${index}.cjs');`;
 }
 source+=`app.get('/health',()=>{});process.on('SIGTERM',()=>{});app.listen(3000);`;
 await writeFile(path.join(root,'main.cts'),source);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));
 assert.equal(report.findings.filter(f=>['missing-health-endpoint','missing-graceful-shutdown'].includes(f.id)).length,0);
});
