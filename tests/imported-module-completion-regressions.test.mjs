import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

const setup=`app.get('/health',()=> 'ok');process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{});`;
async function audit(t,body,signals='await load();'+setup,extra={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-imported-module-completion-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const files={
  'package.json':'{"type":"module","dependencies":{"express":"*"}}',
  'app.ts':`import express from 'express';export const app=express();`,
  'signals.ts':`import {app}from './app.js';${signals}`,
  'main.ts':`import {app}from './app.js';async function work(){throw Error()}${body}`,
  ...extra,
 };
 for(const[name,text]of Object.entries(files))await writeFile(path.join(root,name),text);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.filter(f=>['missing-health-endpoint','missing-graceful-shutdown','missing-rejection-handler'].includes(f.id));
}
for(const body of [
 `await import('./signals.js');`,
 `const pending=import('./signals.js');await pending;`,
 `const pending=import('./signals.js');const alias=pending;await (alias satisfies Promise<any>);`,
 `function setup(){return import('./signals.js')}await setup();`,
 `function setup(){const pending=import('./signals.js');return pending}await setup();`,
 `async function setup(){const pending=import('./signals.js');await pending}await setup();`,
 `const setup=()=>import('./signals.js');await setup();`,
])test('completed imported module retains registrations after top-level await: '+body,async t=>{
 assert.equal((await audit(t,body+'app.listen(3000);work();')).length,0);
});
for(const body of [
 `app.listen(3000);work();await import('./signals.js');`,
 `const pending=import('./signals.js');app.listen(3000);work();await pending;`,
 `function setup(){return import('./signals.js')}app.listen(3000);work();await setup();`,
 `const pending=import('./signals.js');app.listen(3000);work();`,
 `function setup(){const pending=import('./signals.js');try{return pending}finally{return undefined}}await setup();app.listen(3000);work();`,
])test('imported module completion cannot backfill or donate discarded setup: '+body,async t=>{
 assert.equal((await audit(t,body)).length,3);
});
for(const [label,mid]of [
 ['static import',`import './signals.js';`],
 ['awaited import',`await import('./signals.js');`],
 ['awaited alias',`const pending=import('./signals.js');await pending;`],
])test('completed module follows nested '+label,async t=>{
 assert.equal((await audit(t,`await import('./mid.js');app.listen(3000);work();`,undefined,{'mid.ts':mid})).length,0);
});
for(const [label,mid]of [
 ['detached import',`import('./signals.js');`],
 ['caught require',`try{require('./signals.js')}catch{}`],
])test('completed module does not upgrade nested '+label,async t=>{
 assert.equal((await audit(t,`await import('./mid.js');app.listen(3000);work();`,undefined,{'mid.ts':mid})).length,3);
});
for(const failure of [`await Promise.reject(Error());`,`await new Promise(()=>{});`,`throw Error();`])test('failed or pending module cannot donate completion: '+failure,async t=>{
 assert.equal((await audit(t,`try{await import('./signals.js')}catch{}app.listen(3000);work();`,failure+setup)).length,3);
});
test('an awaited importer cannot protect the dependency own earlier listener',async t=>{
 const findings=await audit(t,`await import('./signals.js');app.listen(4000);work();`,`app.listen(3000);await load();${setup}`);
 assert.equal(findings.filter(f=>f.id==='missing-health-endpoint').length,1);
 assert.equal(findings.filter(f=>f.id==='missing-graceful-shutdown').length,1);
 assert.ok(findings.filter(f=>f.id!=='missing-rejection-handler').every(f=>f.file==='signals.ts'));
});
test('completed imported helper keeps receiver argument identity',async t=>{
 assert.equal((await audit(t,`const pending=import('./signals.js');await pending;app.listen(3000);work();`,`function install(target){target.get('/health',()=> 'ok');process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{})}await load();install(app);`)).length,0);
});
test('unknown guards in completed imported module remain uncertain',async t=>{
 assert.equal((await audit(t,`await import('./signals.js');app.listen(3000);work();`,`await load();if(enabled){${setup}}`)).length,3);
});
test('caught synchronous require failure cannot erase completed importer setup',async t=>{
 assert.equal((await audit(t,`await import('./signals.js');app.listen(3000);work();`,`try{require('./broken.js')}catch{}await load();${setup}`,{'broken.ts':`throw Error();`})).length,0);
});
