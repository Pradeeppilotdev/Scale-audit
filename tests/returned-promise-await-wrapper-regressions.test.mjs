import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';
const head=`import express from 'express';const app=express();`;
const protection=`process.on('SIGTERM',()=>{});app.get('/health',()=> 'ok');`;
const installer=`async function install(){await load();${protection}}`;
async function audit(t,body,files={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-returned-promise-await-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),JSON.stringify({type:'module',dependencies:{express:'*'}}));
 for(const [name,content]of Object.entries({'main.ts':head+body,...files}))await writeFile(path.join(root,name),content);
 const r=await runAudit(root);assert.equal(r.complete,true,JSON.stringify(r.detectors));
 return r.findings.filter(f=>['missing-health-endpoint','missing-graceful-shutdown'].includes(f.id));
}
for(const wrapper of [
 `function setup(){return install()}`,
 `async function setup(){return install()}`,
 `const setup=()=>install();`,
 `function inner(){return install()}function setup(){return inner()}`,
 `async function inner(){return install()}function setup(){return inner()}`,
 `function setup(enabled){return enabled?install():undefined}`,
 `function setup(enabled){return enabled&&install()}`,
])test('awaited returned promise establishes later startup: '+wrapper,async t=>{
 const argument=wrapper.includes('enabled')?'true':'';
 assert.equal((await audit(t,installer+wrapper+`await setup(${argument});app.listen(3000);`)).length,0);
});
for(const wrapper of [`function setup(){return install()}`,`async function setup(){return install()}`,`const setup=()=>install();`])test('returned promise cannot backfill an earlier listener: '+wrapper,async t=>{
 assert.equal((await audit(t,installer+wrapper+`app.listen(3000);await setup();`)).length,2);
});
test('detached returned promise cannot protect outside startup',async t=>{
 assert.equal((await audit(t,installer+`function setup(){return install()}setup();app.listen(3000);`)).length,2);
});
for(const guard of ['false','enabled'])test('skipped or unknown returned branch cannot establish protection: '+guard,async t=>{
 assert.equal((await audit(t,installer+`declare const enabled:boolean;function setup(flag){return flag?install():undefined}await setup(${guard});app.listen(3000);`)).length,2);
});
test('synchronous finally remains immediate while returned installer is pending',async t=>{
 const f=await audit(t,`async function install(){await load();app.get('/health',()=> 'ok')}function setup(){try{return install()}finally{process.on('SIGTERM',()=>{})}}app.listen(3000);await setup();`);
 assert.ok(f.some(x=>x.id==='missing-health-endpoint'));assert.ok(!f.some(x=>x.id==='missing-graceful-shutdown'));
});
for(const end of ['return undefined','throw Error()'])test('overriding finally cannot adopt discarded installer: '+end,async t=>{
 assert.equal((await audit(t,installer+`function setup(){try{return install()}finally{${end}}}try{await setup()}catch{}app.listen(3000);`)).length,2);
});
for(const value of ['new Promise(()=>{})','Promise.reject(Error())'])test('returned pending/rejected promise cannot backfill an earlier listener: '+value,async t=>{
 assert.equal((await audit(t,`function setup(){return ${value}}app.listen(3000);try{await setup()}catch{}${protection}`)).length,2);
});
for(const wrapper of [
 `(setup() satisfies Promise<void>)`,
 `(setup() as Promise<void>)`,
 `(<Promise<void>>setup())`,
 `((setup() as Promise<void>)!)`,
])test('awaited helper recognizes erased parent wrapper: '+wrapper,async t=>{
 assert.equal((await audit(t,installer+`async function setup(){await install()}await ${wrapper};app.listen(3000);`)).length,0);
});
for(const wrapper of [
 `(import('./signals.js') satisfies Promise<unknown>)`,
 `(import('./signals.js') as Promise<unknown>)`,
 `(<Promise<unknown>>import('./signals.js'))`,
 `((import('./signals.js') as Promise<unknown>)!)`,
])test('awaited import recognizes erased parent wrapper: '+wrapper,async t=>{
 const f=await audit(t,`await ${wrapper};app.listen(3000);`,{'signals.ts':`process.on('SIGTERM',()=>{});`});
 assert.ok(!f.some(x=>x.id==='missing-graceful-shutdown'));
});
test('returned awaited import contributes completed setup only to later startup',async t=>{
 const f=await audit(t,`function setup(){return import('./signals.js')}await setup();app.listen(3000);`,{'signals.ts':`process.on('SIGTERM',()=>{});`});
 assert.ok(!f.some(x=>x.id==='missing-graceful-shutdown'));
});

test('caught finally helper throw cannot donate a discarded installer completion',async t=>{
 assert.equal((await audit(t,installer+`function fail(){throw Error()}function setup(){try{return install()}finally{fail()}}async function outer(){try{await setup()}catch{}}await outer();app.listen(3000);`)).length,2);
});
test('known skipped finally return preserves promise adoption',async t=>{
 assert.equal((await audit(t,installer+`function setup(stop){try{return install()}finally{if(stop)return undefined}}await setup(false);app.listen(3000);`)).length,0);
});
test('unknown finally return cannot promise asynchronous installer completion',async t=>{
 assert.equal((await audit(t,installer+`declare const stop:boolean;function setup(stop){try{return install()}finally{if(stop)return undefined}}await setup(stop);app.listen(3000);`)).length,2);
});
test('finally return overrides a pending returned promise without stalling setup',async t=>{
 assert.equal((await audit(t,`function setup(){try{return new Promise(()=>{})}finally{return undefined}}await setup();${protection}app.listen(3000);`)).length,0);
});
