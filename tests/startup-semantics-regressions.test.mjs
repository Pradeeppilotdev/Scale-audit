import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

const head = `import express from 'express';const app=express();`;
const protect = `app.get('/health',()=> 'ok');process.on('SIGTERM',()=>{});`;
async function audit(t, body) {
  const root=await mkdtemp(path.join(os.tmpdir(),'scale-startup-semantics-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'package.json'),JSON.stringify({dependencies:{express:'*'}}));
  await writeFile(path.join(root,'app.ts'),head+body);
  const report=await runAudit(root);
  assert.equal(report.complete,true,JSON.stringify(report.detectors));
  return report.findings;
}
const missing=(findings,id)=>findings.some(f=>f.id===id);
for(const expression of [
 `const maybe=undefined;maybe?.(process.on('SIGTERM',()=>{}));`,
 `const maybe=null;maybe?.install(process.on('SIGTERM',()=>{}));`,
 `const maybe=null;maybe?.[process.on('SIGTERM',()=>{})]();`,
 `const maybe=null;maybe?.install?.(process.on('SIGTERM',()=>{}));`,
 `declare const maybe:any;maybe?.(process.on('SIGTERM',()=>{}));`,
 `declare const maybe:any;maybe?.[process.on('SIGTERM',()=>{})]();`,
])test(`optional invocation cannot establish skipped/conditional registration: ${expression}`,async t=>{
 const findings=await audit(t,expression+'app.listen(3000);');
 assert.ok(missing(findings,'missing-graceful-shutdown'));
});
for(const expression of [
 `const install=()=>{};install?.(process.on('SIGTERM',()=>{}));`,
 `const target={install(){}};target?.install(process.on('SIGTERM',()=>{}));`,
 `const target={install(){}};target?.[(process.on('SIGTERM',()=>{}),'install')]();`,
])test(`known-present optional receiver evaluates its arguments/key: ${expression}`,async t=>{
 const findings=await audit(t,expression+'app.listen(3000);');
 assert.ok(!missing(findings,'missing-graceful-shutdown'));
});
for(const expression of ['Promise.reject(Error("stop"))','new Promise(()=>{})'])test(`await ${expression} cannot establish subsequent setup`,async t=>{
 const findings=await audit(t,`async function setup(){await ${expression};${protect}}setup();app.listen(3000);`);
 assert.ok(missing(findings,'missing-graceful-shutdown'));assert.ok(missing(findings,'missing-health-endpoint'));
});
test('detached asynchronous continuation does not protect an outside listener',async t=>{
 const findings=await audit(t,`async function setup(){await load();${protect}}setup();app.listen(3000);`);
 assert.ok(missing(findings,'missing-graceful-shutdown'));assert.ok(missing(findings,'missing-health-endpoint'));
});
for(const prefix of [`try{throw Error('expected')}catch{}`,`function validate(){try{throw Error('expected')}catch{}}validate();`])test(`caught exception permits subsequent protection: ${prefix}`,async t=>{
 const findings=await audit(t,prefix+protect+'app.listen(3000);');
 assert.ok(!missing(findings,'missing-graceful-shutdown'));assert.ok(!missing(findings,'missing-health-endpoint'));
});
test('uncaught rethrow still prevents protective evidence',async t=>{
 const findings=await audit(t,`function validate(){try{throw Error('expected')}catch(e){throw e}}validate();${protect}app.listen(3000);`);
 assert.ok(missing(findings,'missing-graceful-shutdown'));assert.ok(missing(findings,'missing-health-endpoint'));
});
test('repeated valid signal invocations preserve their distinct event bindings',async t=>{
 const findings=await audit(t,`function install(event,handler){process.on(event,handler)}const handler=()=>{};install('SIGTERM',handler);install('SIGINT',handler);app.listen(3000);`);
 assert.ok(!missing(findings,'missing-graceful-shutdown'));
});
test('equivalent repeated helper arguments retain route evidence',async t=>{
 const findings=await audit(t,`function routes(target){target.get('/health',()=> 'ok')}routes(app);routes(app);app.listen(3000);`);
 assert.ok(!missing(findings,'missing-health-endpoint'));
});
test('invocation alternatives cannot mix receiver and event from different calls',async t=>{
 const findings=await audit(t,`function install(target,event,handler){target.on(event,handler)}const fake={on(){}};install(process,'other',()=>{});install(fake,'SIGTERM',()=>{});app.listen(3000);`);
 assert.ok(missing(findings,'missing-graceful-shutdown'));
});
test('uncertain valid invocation cannot repair a definite invalid invocation',async t=>{
 const findings=await audit(t,`function install(handler){process.on('SIGTERM',handler)}install(null);if(enabled)install(()=>{});app.listen(3000);`);
 assert.ok(missing(findings,'missing-graceful-shutdown'));
});
test('definite valid invocation survives an uncertain invalid invocation',async t=>{
 const findings=await audit(t,`function install(handler){process.on('SIGTERM',handler)}install(()=>{});if(enabled)install(null);app.listen(3000);`);
 assert.ok(!missing(findings,'missing-graceful-shutdown'));
});

for(const body of [
 `async function start(){app.listen(3000);await waitForExternalSignal();${protect}}start();`,
 `async function start(){(app.listen(3000),await waitForExternalSignal(),process.on('SIGTERM',()=>{}));}start();`,
])test('await after listener cannot establish later protection',async t=>{
 const findings=await audit(t,body);assert.ok(missing(findings,'missing-graceful-shutdown'));assert.ok(missing(findings,'missing-health-endpoint'));
});
test('completed await before listener preserves same-continuation safeguards',async t=>{
 const findings=await audit(t,`async function start(){await waitForExternalSignal();app.listen(3000);${protect}}start();`);
 assert.ok(!missing(findings,'missing-graceful-shutdown'));assert.ok(!missing(findings,'missing-health-endpoint'));
});
test('null optional receiver skips later nonoptional computed chain segments',async t=>{
 const findings=await audit(t,`const maybe=null;maybe?.property[process.on('SIGTERM',()=>{})]();app.listen(3000);`);
 assert.ok(missing(findings,'missing-graceful-shutdown'));
});
