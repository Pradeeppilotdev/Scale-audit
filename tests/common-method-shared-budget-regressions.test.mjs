import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

async function fixture(t,files){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-common-method-shared-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),JSON.stringify({dependencies:{express:'*'}}));
 for(const [rel,source]of Object.entries(files))await writeFile(path.join(root,rel),source);
 const report=await runAudit(root);
 assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report;
}
const lifecycle=report=>report.findings.filter(f=>['missing-health-endpoint','missing-graceful-shutdown'].includes(f.id));
for(const [kind,head,call]of [
 ['numeric map lookups',`const cache=new Map();`,i=>`cache.get(${i});`],
 ['unknown-key map lookups',`const cache=new Map();declare const key:any;`,()=>`cache.get(key);`],
 ['unrelated emitter subscriptions',`import{EventEmitter}from 'node:events';const bus=new EventEmitter();`,i=>`bus.on('event${i}',()=>{});`],
 ['nonhealth routes',`import express from 'express';const router=express.Router();`,i=>`router.get('/users/${i}',()=>{});`],
])test(`100 unprotected services share 1000 ${kind} within unchanged work limits`,async t=>{
 const files={'shared.ts':head+Array.from({length:1000},(_,i)=>call(i)).join('\n')};
 for(let i=0;i<100;i++)files[`entry${i}.ts`]=`import './shared';import express from 'express';const app=express();app.listen(${3000+i});`;
 const report=await fixture(t,files);
 assert.equal(report.coverage.analyzed,101);
 const findings=lifecycle(report);
 assert.equal(findings.length,200);
 assert.equal(new Set(findings.map(f=>f.file)).size,100);
});

test('dynamic helper route and process event arguments retain valid protection',async t=>{
 const report=await fixture(t,{
  'shared.ts':`export function install(target,path,event,callback){target.get(path,callback);process.on(event,callback)}`,
  'main.ts':`import express from 'express';import{install}from './shared';const app=express();install(app,'/health','SIGTERM',()=>{});app.listen(3000);`,
 });
 assert.equal(lifecycle(report).length,0);
});

test('nonprotective helper arguments cannot invent health or shutdown protection',async t=>{
 const report=await fixture(t,{
  'main.ts':`import express from 'express';const app=express();function install(target,path,event,callback){target.get(path,callback);process.on(event,callback)}install(app,'/users','other',()=>{});app.listen(3000);`,
 });
 assert.equal(lifecycle(report).length,2);
});

test('root-mounted router health remains a protection candidate',async t=>{
 const report=await fixture(t,{'main.ts':`import express from 'express';const app=express();const router=express.Router();router.get('/health',()=>{});app.use('/',router);process.on('SIGTERM',()=>{});app.listen(3000);`});
 assert.equal(lifecycle(report).length,0);
});

test('asserted static health and shutdown event literals remain candidates',async t=>{
 const report=await fixture(t,{'main.ts':`import express from 'express';const app=express();const health='/health' as const;const event='SIGTERM' as const;app.get(health,()=>{});process.on(event,()=>{});app.listen(3000);`});
 assert.equal(lifecycle(report).length,0);
});
