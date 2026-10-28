import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

const setup=`app.get('/health',()=> 'ok');process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{});`;
async function audit(t,a,b='',extra={},main=`await import('./a.js');app.listen(3000);work();`){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-pending-import-cycle-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const files={
  'package.json':'{"type":"module","dependencies":{"express":"*"}}',
  'app.ts':`import express from 'express';export const app=express();`,
  'main.ts':`import {app}from './app.js';async function work(){throw Error()}${main}`,
  'a.ts':`import {app}from './app.js';${a}`,
  'b.ts':b,
  ...extra,
 };
 for(const[name,source]of Object.entries(files))await writeFile(path.join(root,name),source);
 const report=await runAudit(root);
 assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.filter(f=>['missing-health-endpoint','missing-graceful-shutdown','missing-rejection-handler'].includes(f.id));
}
for(const attempt of [
 `await import('./b.js');`,
 `try{await import('./b.js')}catch{}`,
 `const pending=import('./b.js');await pending;`,
 `const pending=import('./b.js');try{await pending}catch{}`,
 `function load(){return import('./b.js')}await load();`,
 `function load(){const pending=import('./b.js');return pending}try{await load()}catch{}`,
 `async function load(){await import('./b.js')}await load();`,
])test('awaited dynamic cycle cannot donate post-cycle setup: '+attempt,async t=>{
 assert.equal((await audit(t,attempt+setup,`await import('./a.js');`)).length,3);
});
for(const [label,a,b]of[
 ['static then dynamic',`import './b.js';${setup}`,`await import('./a.js');`],
 ['dynamic then static',`await import('./b.js');${setup}`,`import './a.js';`],
 ['self dynamic',`await import('./a.js');${setup}`,``],
 ['caught self dynamic',`try{await import('./a.js')}catch{}${setup}`,``],
])test('mixed or self awaited cycle cannot resume: '+label,async t=>{
 assert.equal((await audit(t,a,b)).length,3);
});
test('three-module dynamic cycle remains pending',async t=>{
 assert.equal((await audit(t,`await import('./b.js');${setup}`,`await import('./c.js');`,{'c.ts':`await import('./a.js');`})).length,3);
});
for(const [label,a,b]of[
 ['ordinary static cycle',`import './b.js';${setup}`,`import './a.js';`],
 ['static self import',`import './a.js';${setup}`,``],
 ['static target already completed',`import './b.js';await import('./b.js');${setup}`,`import './a.js';`],
 ['completed target through alias',`import './b.js';const pending=import('./b.js');await pending;${setup}`,`import './a.js';`],
 ['completed target through helper',`import './b.js';async function load(){await import('./b.js')}await load();${setup}`,`import './a.js';`],
 ['detached dynamic cycle resolves after caller',`import('./b.js');${setup}`,`await import('./a.js');`],
])test('completing import graph retains setup: '+label,async t=>{
 assert.equal((await audit(t,a,b)).length,0);
});
test('static dependencies complete before a later helper imports the same target',async t=>{
 assert.equal((await audit(t,`import './b.js';async function load(){await import('./b.js');${setup}}await load();app.listen(3001);`,`import './a.js';`)).length,0);
});
test('repeated awaited imports reuse completed shared graph work',async t=>{
 const imports=Array.from({length:400},()=>`await import('./b.js');`).join('');
 assert.equal((await audit(t,`import './b.js';${imports}${setup}`,`import './a.js';`)).length,0);
});
test('entering the same mixed static graph through the unfinished target remains pending',async t=>{
 assert.equal((await audit(t,`import './b.js';await import('./b.js');${setup}`,`import './a.js';`,{},`await import('./b.js');app.listen(3000);work();`)).length,3);
});
test('contextual helper completion cannot backfill an earlier caller listener',async t=>{
 const findings=await audit(t,`import './b.js';async function load(){await import('./b.js');${setup}}app.listen(3001);await load();`,`import './a.js';`);
 assert.equal(findings.length,2);
 assert.ok(findings.every(f=>f.file==='a.ts'));
});
test('contextual helper proof keeps failed and successful invocation bindings separate',async t=>{
 const findings=await audit(t,`import './b.js';import express from 'express';const other=express();async function load(target,specifier){await import(specifier);target.get('/health',()=> 'ok')}try{await load(app,'./bad.js')}catch{}await load(other,'./b.js');process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{});app.listen(3001);other.listen(3002);`,`import './a.js';`,{'bad.ts':`throw Error();`});
 assert.equal(findings.length,2);
 assert.ok(findings.every(f=>f.id==='missing-health-endpoint'));
});
