import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runAudit} from '../dist/runner.js';

async function audit(t, body){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-helper-latest-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),JSON.stringify({dependencies:{express:'*'}}));
 await writeFile(path.join(root,'main.ts'),`import express from 'express';${body}`);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));return report.findings;
}
const has=(findings,id)=>findings.some(f=>f.id===id);
test('separate helper allocations cannot share health evidence',async t=>{
 const findings=await audit(t,`function boot(route,port){const app=express();app.get(route,()=> 'ok');app.listen(port)}boot('/health',3000);boot('/users',4000);`);
 assert.ok(has(findings,'missing-health-endpoint'));
});
test('separate helper allocations remain healthy when each has its own health route',async t=>{
 const findings=await audit(t,`function boot(route,port){const app=express();app.get(route,()=> 'ok');app.listen(port)}boot('/health',3000);boot('/health',4000);`);
 assert.ok(!has(findings,'missing-health-endpoint'));
});
test('nested helper allocations preserve the outer allocating invocation',async t=>{
 const findings=await audit(t,`function routes(target,route){target.get(route,()=> 'ok')}function boot(route,port){const app=express();routes(app,route);app.listen(port)}boot('/health',3000);boot('/users',4000);`);
 assert.ok(has(findings,'missing-health-endpoint'));
});
test('shared outer allocation retains valid evidence across separate helper invocations',async t=>{
 const findings=await audit(t,`const app=express();function routes(target,route){target.get(route,()=> 'ok')}routes(app,'/health');routes(app,'/users');app.listen(3000);`);
 assert.ok(!has(findings,'missing-health-endpoint'));
});
test('immutable helper receiver aliases retain argument bindings',async t=>{
 const findings=await audit(t,`const app=express();function setup(target){const alias=target;alias.get('/health',()=> 'ok')}setup(app);app.listen(3000);`);
 assert.ok(!has(findings,'missing-health-endpoint'));
});
test('multiple helper receiver aliases retain argument bindings',async t=>{
 const findings=await audit(t,`const app=express();function setup(target){const one=target;const two=one;two.get('/health',()=> 'ok')}setup(app);app.listen(3000);`);
 assert.ok(!has(findings,'missing-health-endpoint'));
});
test('immutable helper callback aliases retain signal bindings',async t=>{
 const findings=await audit(t,`const app=express();function install(cb){const alias=cb;process.on('SIGTERM',alias)}install(()=>{});app.listen(3000);`);
 assert.ok(!has(findings,'missing-graceful-shutdown'));
});
test('callback aliases cannot combine bindings from different helper invocations',async t=>{
 const findings=await audit(t,`const app=express();function install(event,cb){const alias=cb;process.on(event,alias)}install('other',()=>{});install('SIGTERM',null);app.listen(3000);`);
 assert.ok(has(findings,'missing-graceful-shutdown'));
});
test('mutable callback aliases cannot retain stale callback proof',async t=>{
 const findings=await audit(t,`const app=express();function install(cb){let alias=cb;alias=null;process.on('SIGTERM',alias)}install(()=>{});app.listen(3000);`);
 assert.ok(has(findings,'missing-graceful-shutdown'));
});
test('immutable undefined argument aliases apply helper defaults',async t=>{
 const findings=await audit(t,`const app=express();const omitted=undefined;function setup(target,route='/health'){target.get(route,()=> 'ok')}setup(app,omitted);app.listen(3000);`);
 assert.ok(!has(findings,'missing-health-endpoint'));
});
