import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

const setup=`app.get('/health',()=> 'ok');process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{});`;
const ids=new Set(['missing-health-endpoint','missing-graceful-shutdown','missing-rejection-handler']);
async function audit(t,body,files={'bad.cjs':`throw Error('failed');`}){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-require-failure-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),'{"type":"commonjs","dependencies":{"express":"*"}}');
 await writeFile(path.join(root,'main.cts'),`const express=require('express');const app=express();async function work(){throw Error()}${body}`);
 for(const[name,source]of Object.entries(files))await writeFile(path.join(root,name),source);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.filter(f=>ids.has(f.id));
}
for(const load of [
 `require('./bad.cjs');`,
 `const specifier='./bad.cjs';require(specifier);`,
 `function load(){require('./bad.cjs')}load();`,
])test('throwing local require prevents later synchronous helper setup: '+load,async t=>{
 assert.equal((await audit(t,`function install(){${load}${setup}}try{install()}catch{}app.listen(3000);work();`)).length,3);
});
for(const body of [
 `try{require('./bad.cjs')}catch{}${setup}app.listen(3000);work();`,
 `function install(){require('./bad.cjs')}try{install()}catch{}${setup}app.listen(3000);work();`,
 `function install(){${setup}require('./bad.cjs')}try{install()}catch{}app.listen(3000);work();`,
])test('caught local require preserves independently reached setup: '+body.slice(0,90),async t=>{
 assert.equal((await audit(t,body)).length,0);
});
test('clean synchronous dependency retains helper setup',async t=>{
 assert.equal((await audit(t,`function install(){require('./bad.cjs');${setup}}try{install()}catch{}app.listen(3000);work();`,{'bad.cjs':`const value=1;`})).length,0);
});
test('dependency-local catch retains normal CommonJS completion',async t=>{
 assert.equal((await audit(t,`function install(){require('./bad.cjs');${setup}}install();app.listen(3000);work();`,{'bad.cjs':`try{throw Error()}catch{}`})).length,0);
});
test('transitive synchronous require failures prevent helper completion',async t=>{
 assert.equal((await audit(t,`function install(){require('./bad.cjs');${setup}}try{install()}catch{}app.listen(3000);work();`,{'bad.cjs':`require('./leaf.cjs');`,'leaf.cjs':`throw Error();`})).length,3);
});
test('CommonJS partial-export cycles remain valid',async t=>{
 assert.equal((await audit(t,`function install(){require('./bad.cjs');${setup}}install();app.listen(3000);work();`,{'bad.cjs':`require('./leaf.cjs');`,'leaf.cjs':`require('./bad.cjs');`})).length,0);
});
test('CommonJS cycles scheduled after their entry retain partial exports',async t=>{
 assert.equal((await audit(t,`function install(){require('./zbad.cjs');${setup}}install();app.listen(3000);work();`,{
  'zbad.cjs':`require('./zzleaf.cjs');`,'zzleaf.cjs':`require('./zbad.cjs');`,
 })).length,0);
});
test('uncalled require references cannot create a phantom partial-export cycle',async t=>{
 assert.equal((await audit(t,`function install(){require('./a.cts');${setup}}try{install()}catch{}app.listen(3000);work();`,{
  'a.cts':`require('./b.cjs');throw Error();`,'b.cjs':`function unused(){require('./main.cts')}`,
 })).length,3);
});
test('unplanned helper-bound local require completion stays uncertain',async t=>{
 assert.equal((await audit(t,`function install(){require('./zzchild.cjs');${setup}}try{install()}catch{}app.listen(3000);work();`,{
  'zzchild.cjs':`function load(specifier){require(specifier)}load('./zzzbad.cjs');`,
  'zzzbad.cjs':`throw Error();`,
 })).length,3);
});
test('ordinary long CommonJS dependency chains stay iterative',async t=>{
 const files={};for(let index=0;index<200;index++)files[index===0?'bad.cjs':`dep${index}.cjs`]=index===199?`const value=1;`:`require('./dep${index+1}.cjs');`;
 assert.equal((await audit(t,`require('./bad.cjs');${setup}app.listen(3000);work();`,files)).length,0);
});
test('uncalled helper dependency cannot poison executed setup',async t=>{
 assert.equal((await audit(t,`function unused(){require('./bad.cjs')}${setup}app.listen(3000);work();`)).length,0);
});
for(const guarded of [
 `if(false)require('./zzleaf.cjs');`,
 `false&&require('./zzleaf.cjs');`,
 `true||require('./zzleaf.cjs');`,
 `false?require('./zzleaf.cjs'):undefined;`,
 `null?.(require('./zzleaf.cjs'));`,
 `while(false)require('./zzleaf.cjs');`,
 `declare const enabled:boolean;if(enabled)require('./zzleaf.cjs');`,
])test('guarded scheduling cannot manufacture a reusable partial-export cycle: '+guarded,async t=>{
 assert.equal((await audit(t,`try{require('./zbad.cjs')}catch{}function install(){require('./zzleaf.cjs');${setup}}try{install()}catch{}app.listen(3000);work();`,{
  'zbad.cjs':guarded+`throw Error();`,'zzleaf.cjs':`require('./zbad.cjs');`,
 })).length,3);
});
