import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

async function auditServices(t, count, unprotected = -1) {
  const root=await mkdtemp(path.join(os.tmpdir(),'scale-shared-protected-startup-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'package.json'),JSON.stringify({dependencies:{express:'*'}}));
  await writeFile(path.join(root,'shared.ts'),Array.from({length:1000},(_,i)=>`register(${i});`).join('\n'));
  for(let i=0;i<count;i++) {
    const protection=(unprotected===-2||i===unprotected)?'':`app.get('/health',()=> 'ok');process.on('SIGTERM',()=>{});`;
    await writeFile(path.join(root,`entry${i}.ts`),`import './shared';import express from 'express';const app=express();${protection}app.listen(${3000+i});`);
  }
  const report=await runAudit(root);
  assert.equal(report.complete,true,JSON.stringify(report.detectors));
  assert.equal(report.coverage.analyzed,count+1);
  return report.findings.filter(f=>['missing-health-endpoint','missing-graceful-shutdown'].includes(f.id));
}
for(const count of [100,250])test(`${count} protected services share 1000 startup calls within unchanged work limits`,async t=>{
  assert.equal((await auditServices(t,count)).length,0);
});
test('shared startup optimization preserves an unprotected service among protected entries',async t=>{
  const findings=await auditServices(t,100,99);
  assert.equal(findings.length,2);
  assert.ok(findings.every(f=>f.file==='entry99.ts'));
  assert.deepEqual(new Set(findings.map(f=>f.id)),new Set(['missing-health-endpoint','missing-graceful-shutdown']));
});

test('100 unprotected services retain complete shared-call absence checks',async t=>{
  const findings=await auditServices(t,100,-2);
  assert.equal(findings.length,200);
  assert.equal(new Set(findings.map(f=>f.file)).size,100);
});
