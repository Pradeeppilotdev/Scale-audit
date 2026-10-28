import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

async function audit(t,body){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-promise-completion-integration-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),'{"type":"module","dependencies":{"express":"*"}}');
 await writeFile(path.join(root,'main.ts'),`import express from 'express';const app=express();async function install(target=app){await load();process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{});target.get('/health',()=> 'ok')}async function work(){throw Error('failed')}${body}`);
 const report=await runAudit(root);
 assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings;
}
const lifecycle=new Set(['missing-health-endpoint','missing-graceful-shutdown']);
const missingLifecycle=findings=>findings.filter(f=>lifecycle.has(f.id));
const missingRejection=findings=>findings.some(f=>f.id==='missing-rejection-handler');

for(const prefix of ['', 'async '])test('returned promise alias completion does not backfill earlier listeners: '+(prefix||'sync'),async t=>{
 const findings=await audit(t,`${prefix}function setup(){const pending=install();return pending}app.listen(3000);await setup();`);
 assert.equal(missingLifecycle(findings).length,2);
});
test('returned promise alias completion does not backfill earlier unhandled work',async t=>{
 assert.ok(missingRejection(await audit(t,`function setup(){const pending=install();return pending}work();await setup();`)));
});
test('detached promise alias remains unprotected',async t=>{
 const findings=await audit(t,`function setup(){const pending=install();return pending}setup();app.listen(3000);work();`);
 assert.equal(missingLifecycle(findings).length,2);assert.ok(missingRejection(findings));
});
for(const completion of ['return undefined','throw Error()'])test('finally override discards returned alias completion: '+completion,async t=>{
 const findings=await audit(t,`function setup(){const pending=install();try{return pending}finally{${completion}}}try{await setup()}catch{}app.listen(3000);work();`);
 assert.equal(missingLifecycle(findings).length,2);assert.ok(missingRejection(findings));
});
for(const assignment of ['pending=Promise.resolve()','if(enabled)pending=Promise.resolve()'])test('mutable promise alias cannot establish discarded or uncertain completion: '+assignment,async t=>{
 const findings=await audit(t,`declare const enabled:boolean;function setup(){let pending=install();${assignment};return pending}await setup();app.listen(3000);work();`);
 assert.equal(missingLifecycle(findings).length,2);assert.ok(missingRejection(findings));
});
test('returned alias completion stays isolated between helper invocation arguments',async t=>{
 const findings=await audit(t,`const second=express();function setup(target,enabled){const pending=enabled?install(target):Promise.resolve();return pending}await setup(app,true);await setup(second,false);app.listen(3000);second.listen(4000);`);
 assert.ok(findings.some(f=>f.id==='missing-health-endpoint'));
});
for(const expression of ['false&&pending','true||pending','true?undefined:pending'])test('unselected logical or conditional alias cannot donate completion: '+expression,async t=>{
 const findings=await audit(t,`function setup(){const pending=install();return ${expression}}await setup();app.listen(3000);work();`);
 assert.equal(missingLifecycle(findings).length,2);assert.ok(missingRejection(findings));
});
for(const expression of ['pending||undefined','pending??undefined','true&&pending','true?pending:undefined'])test('selected returned alias retains completion: '+expression,async t=>{
 const findings=await audit(t,`function setup(){const pending=install();return ${expression}}await setup();app.listen(3000);work();`);
 assert.equal(missingLifecycle(findings).length,0);assert.equal(missingRejection(findings),false);
});

test('awaiting a startup promise alias cannot backfill a listener between creation and await',async t=>{
 const findings=await audit(t,`const pending=install();app.listen(3000);await pending;`);
 assert.equal(missingLifecycle(findings).length,2);
});

test('optional async call cannot make a guarded installer definitely execute',async t=>{
 const findings=await audit(t,`declare const enabled:boolean;const api=enabled?{async work(){}}:undefined;await(api?.work()&&install());app.listen(3000);work();`);
 assert.equal(missingLifecycle(findings).length,2);assert.ok(missingRejection(findings));
});
