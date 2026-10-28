import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';
const head=`import express from 'express';const app=express();`;
const setup=`async function setup(enabled){await load();if(enabled){process.on('SIGTERM',()=>{});app.get('/health',()=> 'ok')}return 3000}`;
async function audit(t,body){const root=await mkdtemp(path.join(os.tmpdir(),'scale-helper-isolation-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(root+'/package.json',JSON.stringify({type:'module',dependencies:{express:'*'}}));await writeFile(root+'/main.ts',head+body);const r=await runAudit(root);assert.equal(r.complete,true,JSON.stringify(r.detectors));return r.findings;}
const missing=(f,id)=>f.some(x=>x.id===id);
for(const flags of ['false,3000);await boot(true,4000','false,3000);await boot(false,4000'])test('later completion cannot protect first invocation: '+flags,async t=>{
 const f=await audit(t,setup+`async function boot(enabled,port){await setup(enabled);app.listen(port)}await boot(${flags});`);assert.ok(missing(f,'missing-graceful-shutdown'));assert.ok(missing(f,'missing-health-endpoint'));
});
test('each protected bootstrap retains its own completed setup',async t=>{const f=await audit(t,setup+`async function boot(enabled,port){await setup(enabled);app.listen(port)}await boot(true,3000);await boot(true,4000);`);assert.ok(!missing(f,'missing-graceful-shutdown'));assert.ok(!missing(f,'missing-health-endpoint'));});
test('earlier completed process handler persists into a later bootstrap',async t=>{const f=await audit(t,setup+`async function boot(enabled,port){await setup(enabled);app.listen(port)}await boot(true,3000);await boot(false,4000);`);assert.ok(!missing(f,'missing-graceful-shutdown'));assert.ok(!missing(f,'missing-health-endpoint'));});
test('separate app instances cannot borrow later health or shutdown setup',async t=>{const f=await audit(t,`async function setup(app,enabled){await load();if(enabled){process.on('SIGTERM',()=>{});app.get('/health',()=> 'ok')}}async function boot(enabled,port){const app=express();await setup(app,enabled);app.listen(port)}await boot(false,3000);await boot(true,4000);`);assert.ok(missing(f,'missing-graceful-shutdown'));assert.ok(missing(f,'missing-health-endpoint'));});
for(const expression of ['app.listen(await setup(true));','app.listen((await setup(true)));','const port=await setup(true);app.listen(port);'])test('awaited argument setup precedes listener: '+expression,async t=>{const f=await audit(t,setup+expression);assert.ok(!missing(f,'missing-graceful-shutdown'));assert.ok(!missing(f,'missing-health-endpoint'));});
test('awaited argument cannot invent skipped protection',async t=>{const f=await audit(t,setup+`app.listen(await setup(false));`);assert.ok(missing(f,'missing-graceful-shutdown'));assert.ok(missing(f,'missing-health-endpoint'));});
test('awaited setup after listener cannot backfill protection',async t=>{const f=await audit(t,setup+`app.listen(3000);await setup(true);`);assert.ok(missing(f,'missing-graceful-shutdown'));assert.ok(missing(f,'missing-health-endpoint'));});
test('synchronous argument registration remains valid',async t=>{const f=await audit(t,`function setup(){process.on('SIGTERM',()=>{});app.get('/health',()=> 'ok');return 3000}app.listen(setup());`);assert.ok(!missing(f,'missing-graceful-shutdown'));assert.ok(!missing(f,'missing-health-endpoint'));});
test('await argument inside reused helper retains invocation bindings',async t=>{const f=await audit(t,setup+`async function boot(enabled){app.listen(await setup(enabled))}await boot(false);await boot(true);`);assert.ok(missing(f,'missing-graceful-shutdown'));assert.ok(missing(f,'missing-health-endpoint'));});
