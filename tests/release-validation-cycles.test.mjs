import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

const setup=`app.get('/health',()=> 'ok');process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{});`;
const entry=target=>`import{app}from'./app.js';async function work(){throw Error()}await import('./${target}.js');app.listen(3000);work();`;
async function findings(t,entries){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-release-validation-cycles-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const files={
  'package.json':'{"type":"module","dependencies":{"express":"*"}}',
  'app.ts':`import express from'express';export const app=express();`,
  // Although textually last, the static import evaluates before the dynamic
  // wait. B has finished by the time A's body awaits it when entering via A.
  'a.ts':`import{app}from'./app.js';await import('./b.js');${setup}import './b.js';`,
  'b.ts':`import './a.js';`,
  ...entries,
 };
 for(const[name,source]of Object.entries(files))await writeFile(path.join(root,name),source);
 const report=await runAudit(root);
 assert.equal(report.complete,true,JSON.stringify(report.detectors));
 assert.equal(report.coverage.analyzed,Object.keys(files).length-1);
 return report.findings.filter(f=>['missing-health-endpoint','missing-graceful-shutdown','missing-rejection-handler'].includes(f.id));
}
test('a textually later static import still completes before a dynamic wait',async t=>{
 assert.deepEqual(await findings(t,{'main.ts':entry('a')}),[]);
});
for(const failureFirst of[false,true])test('shared graph caches preserve entry-specific cycle completion: '+(failureFirst?'failure first':'success first'),async t=>{
 const bad=failureFirst?'entry-a.ts':'entry-b.ts';
 const good=failureFirst?'entry-b.ts':'entry-a.ts';
 const result=await findings(t,{[bad]:entry('b'),[good]:entry('a')});
 assert.equal(result.length,3);
 assert.ok(result.every(f=>f.file===bad));
 assert.deepEqual(result.map(f=>f.id).sort(),['missing-graceful-shutdown','missing-health-endpoint','missing-rejection-handler']);
});
