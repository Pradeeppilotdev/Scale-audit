import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';
async function audit(t,body){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-startup-six-reliability-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),'{"type":"module"}');
 await writeFile(path.join(root,'main.ts'),`async function work(){throw Error('failed')} ${body}`);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));return report.findings;
}
for(const body of [
 `await load();function setup(){process.on('unhandledRejection',()=>{})}setup();work();`,
 `await load();work();function setup(){process.on('unhandledRejection',()=>{})}setup();`,
 `async function setup(){await load();process.on('unhandledRejection',()=>{})}await setup();export default 0;work();`,
 `declare const decorate:any;@decorate(process.on('unhandledRejection',()=>{}))class Setup{}work();`,
])test('reached synchronous registration protects unhandled work: '+body.slice(0,85),async t=>{
 const findings=await audit(t,body);
 assert.ok(findings.some(f=>f.id==='floating-promise'));
 assert.ok(!findings.some(f=>f.id==='missing-rejection-handler'));
});
