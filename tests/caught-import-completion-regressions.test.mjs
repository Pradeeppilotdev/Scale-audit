import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

const setup=`app.get('/health',()=> 'ok');process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{});`;
async function audit(t,mid,bad='throw Error();',extra={},main=`await import('./mid.js');app.listen(3000);work();`){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-caught-import-completion-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const files={
  'package.json':'{"type":"module","dependencies":{"express":"*"}}',
  'app.ts':`import express from 'express';export const app=express();`,
  'main.ts':`import {app}from './app.js';async function work(){throw Error()}${main}`,
  'mid.ts':`import {app}from './app.js';${mid}`,
  'bad.ts':bad,
  ...extra,
 };
 for(const[name,text]of Object.entries(files))await writeFile(path.join(root,name),text);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.filter(f=>['missing-health-endpoint','missing-graceful-shutdown','missing-rejection-handler'].includes(f.id));
}
for(const failure of ['throw Error();','await Promise.reject(Error());'])
for(const attempt of [
 `try{await import('./bad.js')}catch{}`,
 `const pending=import('./bad.js');try{await pending}catch{}`,
 `function attempt(){return import('./bad.js')}try{await attempt()}catch{}`,
 `function attempt(){const pending=import('./bad.js');return pending}try{await attempt()}catch{}`,
 `async function attempt(){await import('./bad.js')}try{await attempt()}catch{}`,
])test('caught import failure preserves later parent setup: '+failure+attempt,async t=>{
 assert.equal((await audit(t,attempt+'await load();'+setup,failure)).length,0);
});

test('caught grandchild failure discards its failed parent subtree, keeping caller setup',async t=>{
 assert.equal((await audit(t,`try{await import('./child.js')}catch{}await load();${setup}`,'throw Error();',{
  'child.ts':`import {app}from './app.js';await import('./bad.js');${setup}`,
 })).length,0);
});
test('caught grandchild failure cannot donate failed child registrations',async t=>{
 assert.equal((await audit(t,`try{await import('./child.js')}catch{}`,'throw Error();',{
  'child.ts':`import {app}from './app.js';await import('./bad.js');${setup}`,
 })).length,3);
});
for(const attempt of [
 `await import('./bad.js');`,
 `const pending=import('./bad.js');await pending;`,
 `function attempt(){return import('./bad.js')}await attempt();`,
])test('uncaught rejected imports still invalidate completed parent setup: '+attempt,async t=>{
 assert.equal((await audit(t,attempt+setup)).length,3);
});
for(const failure of [
 `await new Promise(()=>{});`,
 `import './pending.js';throw Error();`,
])test('caught pending imports cannot resume parent setup: '+failure,async t=>{
 assert.equal((await audit(t,`try{await import('./bad.js')}catch{}${setup}`,failure,{'pending.ts':`await new Promise(()=>{});`})).length,3);
});
test('caught import completion cannot backfill an earlier importer listener',async t=>{
 const findings=await audit(t,`try{await import('./bad.js')}catch{}await load();${setup}`,'throw Error();',{},`app.listen(3000);work();await import('./mid.js');`);
 assert.equal(findings.length,3);
});
test('catch-context does not change helper completion caches for uncaught invocations',async t=>{
 assert.equal((await audit(t,`function attempt(){return import('./bad.js')}try{await attempt()}catch{}await attempt();${setup}`)).length,3);
});
test('caught nested rejection keeps earlier successful dependency setup',async t=>{
 assert.equal((await audit(t,`await import('./good.js');try{await import('./bad.js')}catch{}`,'throw Error();',{
  'good.ts':`import{app}from './app.js';await load();${setup}`,
 })).length,0);
});
