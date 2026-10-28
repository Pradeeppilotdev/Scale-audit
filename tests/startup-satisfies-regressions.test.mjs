import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';
async function audit(t,body){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-startup-satisfies-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),JSON.stringify({type:'module',dependencies:{express:'*'}}));
 await writeFile(path.join(root,'main.ts'),`import express from 'express';const app=express();${body}`);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));return report.findings;
}
const lifecycle=f=>f.filter(x=>['missing-graceful-shutdown','missing-health-endpoint'].includes(x.id));
for(const body of [
 `app.get('/health' satisfies string,()=> 'ok');process.on('SIGTERM' satisfies string,()=>{});app.listen(3000);`,
 `function setup(route,event){app.get(route satisfies string,()=> 'ok');process.on(event satisfies string,()=>{})}setup('/health','SIGTERM');app.listen(3000);`,
 `await load();app.get('/health' satisfies string,()=> 'ok');process.on('SIGTERM' satisfies string,()=>{});app.listen(3000);`,
 `(app satisfies any).get('/health',()=> 'ok');(process satisfies any).on('SIGTERM',(()=>{}) satisfies Function);app.listen(3000);`,
])test('erased satisfies wrappers retain startup protection: '+body.slice(0,90),async t=>{
 assert.equal(lifecycle(await audit(t,body)).length,0);
});
test('satisfies cannot turn unrelated route and event into protection',async t=>{
 const findings=await audit(t,`function setup(route,event){app.get(route satisfies string,()=> 'ok');process.on(event satisfies string,()=>{})}setup('/users','message');app.listen(3000);`);
 assert.equal(lifecycle(findings).length,2);
});
test('satisfies preserves rejection handler event and callback after await',async t=>{
 const findings=await audit(t,`await load();process.on('unhandledRejection' satisfies string,(()=>{}) satisfies Function);async function work(){throw Error()}work();`);
 assert.ok(findings.some(f=>f.id==='floating-promise'));
 assert.ok(!findings.some(f=>f.id==='missing-rejection-handler'));
});
