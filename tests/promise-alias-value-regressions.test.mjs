import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

async function audit(t,body){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-promise-alias-value-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),'{"type":"module","dependencies":{"express":"*"}}');
 await writeFile(path.join(root,'main.ts'),`import express from 'express';const app=express();async function install(){await load();process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{});app.get('/health',()=> 'ok')}async function work(){throw Error()}${body}`);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.filter(f=>['missing-health-endpoint','missing-graceful-shutdown','missing-rejection-handler'].includes(f.id));
}
for(const body of [
 'function setup(){const pending=install();return pending}await setup();',
 'async function setup(){const pending=install();return pending}await setup();',
 'const pending=install();const setup=()=>pending;await setup();',
 'const pending=install();const alias=pending;await alias;',
 'async function setup(){const pending=install();await pending}await setup();',
 'const pending=install();await (pending satisfies Promise<void>);',
 'function setup(){return install()||undefined}await setup();',
 'function setup(){return install()??undefined}await setup();',
 'await (0,install());',
 'function setup(){return (0,install())}await setup();',
 'const pending=install();await (0,pending);',
 'const pending=install();await (false||pending);',
 'const pending=install();await (true&&pending);',
 'const pending=install();await (true?pending:undefined);',
 'function setup(){const pending=install();try{return undefined}finally{return pending}}await setup();',
])test('immutable promise value establishes protection after consumption: '+body,async t=>{
 assert.equal((await audit(t,body+'app.listen(3000);work();')).length,0);
});
for(const body of [
 'const pending=install();app.listen(3000);work();await pending;',
 'function setup(){const pending=install();return pending}setup();app.listen(3000);work();',
 'function setup(){const pending=install();try{return pending}finally{return undefined}}await setup();app.listen(3000);work();',
 'function setup(){const pending=install();try{return pending}finally{throw Error()}}try{await setup()}catch{}app.listen(3000);work();',
 'function setup(){const pending=install();try{return pending}finally{app.listen(3000);work()}}await setup();',
 'let pending=install();pending=Promise.resolve();await pending;app.listen(3000);work();',
 'const pending=install();await (pending,undefined);app.listen(3000);work();',
 'const pending=install();await (true||pending);app.listen(3000);work();',
 'const pending=install();await (false&&pending);app.listen(3000);work();',
 'const pending=install();await (false?pending:undefined);app.listen(3000);work();',
 'declare const enabled:boolean;const pending=enabled?install():undefined;await pending;app.listen(3000);work();',
 'function setup(){return install()&&undefined}await setup();app.listen(3000);work();',
])test('discarded or deferred promise value cannot donate completion: '+body,async t=>{
 assert.equal((await audit(t,body)).length,3);
});
for(const expression of ['fn()||undefined','fn()??undefined'])test('helper-bound async callee preserves logical-left returned promise: '+expression,async t=>{
 assert.equal((await audit(t,`function setup(fn){return ${expression}}await setup(install);app.listen(3000);work();`)).length,0);
});
for(const expression of ['fn()||undefined','fn()??undefined'])test('helper-bound async callee preserves logical-left awaited promise: '+expression,async t=>{
 assert.equal((await audit(t,`async function setup(fn){await (${expression})}await setup(install);app.listen(3000);work();`)).length,0);
});
async function imported(t,body){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-import-promise-alias-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),'{"type":"module","dependencies":{"express":"*"}}');
 await writeFile(path.join(root,'signals.ts'),`process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{});`);
 await writeFile(path.join(root,'main.ts'),`import express from 'express';const app=express();async function work(){throw Error()}${body}`);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.filter(f=>['missing-graceful-shutdown','missing-rejection-handler'].includes(f.id));
}
for(const body of [
 `const pending=import('./signals.js');await pending;`,
 `function setup(){const pending=import('./signals.js');return pending}await setup();`,
 `const pending=import('./signals.js');const setup=()=>pending;await setup();`,
])test('literal imported promise alias retains completed handlers: '+body,async t=>{
 assert.equal((await imported(t,body+'app.listen(3000);work();')).length,0);
});
for(const body of [
 `const pending=import('./signals.js');app.listen(3000);work();await pending;`,
 `function setup(){const pending=import('./signals.js');return pending}setup();app.listen(3000);work();`,
 `function setup(){const pending=import('./signals.js');try{return pending}finally{return undefined}}await setup();app.listen(3000);work();`,
])test('literal imported promise alias cannot donate deferred handlers: '+body,async t=>{
 assert.equal((await imported(t,body)).length,2);
});
test('repeated promise alias consumption stays bounded and preserves invocation isolation',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-promise-alias-invocations-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),'{"type":"module","dependencies":{"express":"*"}}');
 const source=`import express from 'express';const protectedApp=express();const bareApp=express();async function install(target){await load();target.get('/health',()=>{});process.on('SIGTERM',()=>{})}async function setup(target,enabled){const pending=enabled?install(target):Promise.resolve();await pending}`
   + Array.from({length:400},()=>`await setup(protectedApp,true);`).join('')
   + `await setup(bareApp,false);protectedApp.listen(3000);bareApp.listen(4000);`;
 await writeFile(path.join(root,'main.ts'),source);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));
 assert.equal(report.findings.filter(f=>f.id==='missing-health-endpoint').length,1);
});
for(const expression of ['api?.work()&&install()','api.work?.()&&install()'])test('uncertain optional async call cannot establish logical continuation: '+expression,async t=>{
 const setup=expression.includes('api?.')?`const api=enabled?{async work(){}}:undefined;`:`const api={work:enabled?async()=>{}:undefined};`;
 assert.equal((await audit(t,`declare const enabled:boolean;${setup}await (${expression});app.listen(3000);work();`)).length,3);
});
test('known present optional async receiver retains logical continuation',async t=>{
 assert.equal((await audit(t,`const api={async work(){}};await (api?.work()&&install());app.listen(3000);work();`)).length,0);
});
