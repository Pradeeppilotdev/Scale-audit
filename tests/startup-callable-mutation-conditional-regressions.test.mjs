import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';
async function audit(t,body){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-callable-mutation-conditional-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),'{"type":"module","dependencies":{"express":"*"}}');
 await writeFile(path.join(root,'main.ts'),`import express from 'express';const app=express();async function install(){await load();process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{});app.get('/health',()=> 'ok')}async function work(){throw Error()}${body}`);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.filter(f=>['missing-health-endpoint','missing-graceful-shutdown','missing-rejection-handler'].includes(f.id));
}
for(const expression of ['pending?pending:undefined','pending?pending:false'])for(const prefix of ['','async '])test(`helper-bound async conditional preserves returned alias: ${prefix}${expression}`,async t=>{
 assert.equal((await audit(t,`${prefix}function setup(fn){const pending=fn();return ${expression}}await setup(install);app.listen(3000);work();`)).length,0);
});
for(const body of [
 'async function setup(fn){const pending=fn();await(pending?pending:undefined)}await setup(install);',
 'function setup(fn){return fn()?install():undefined}await setup(async()=>{});',
 'async function setup(fn){if(fn()){await install()}}await setup(async()=>{});',
])test('helper-bound async condition retains its selected path: '+body,async t=>{
 assert.equal((await audit(t,body+'app.listen(3000);work();')).length,0);
});
for(const body of [
 'function setup(fn){const pending=fn();return pending?undefined:pending}await setup(install);',
 'function setup(fn){return fn()?undefined:install()}await setup(async()=>{});',
 'declare const enabled:boolean;function setup(fn){const pending=enabled?fn():undefined;return pending?pending:undefined}await setup(install);',
])test('unselected or uncertain conditional cannot donate completion: '+body,async t=>{
 assert.equal((await audit(t,body+'app.listen(3000);work();')).length,3);
});
for(const mutation of [
 `Object.assign(api,{check:()=>false});`,
 `Object.defineProperty(api,'check',{value:()=>false});`,
 `Object.defineProperties(api,{check:{value:()=>false}});`,
 `function replace(target){target.check=()=>false}replace(api);`,
 `const alias=api;Object.assign(alias,{check:()=>false});`,
 `mutate(api);`,
 `mutate({api});`,
 `const aliases=[api];aliases[0].check=()=>false;`,
])test('indirect method mutation cannot prove async truthiness: '+mutation,async t=>{
 assert.equal((await audit(t,`const api={async check(){}};${mutation}await(api.check()&&install());app.listen(3000);work();`)).length,3);
});
for(const body of [
 `const api={async check(){},replace(){this.check=()=>false}};api.replace();`,
 `const api={async check(){},get replace(){this.check=()=>false;return 1}};void api.replace;`,
 `class Api{static async check(){}}Object.assign(Api,{check:()=>false});const api=Api;`,
 `class Api{async check(){}}const api=new Api();mutate(api);`,
])test('receiver side effects invalidate async method identity: '+body,async t=>{
 assert.equal((await audit(t,body+'await(api.check()&&install());app.listen(3000);work();')).length,3);
});
for(const mutation of [`Object.assign(api,{setup:async()=>{}});`,`function replace(target){target.setup=async()=>{}}replace(api);`,`mutate(api);`])test('mutated helper method cannot donate stale setup: '+mutation,async t=>{
 assert.equal((await audit(t,`const api={async setup(){await install()}};${mutation}await api.setup();app.listen(3000);work();`)).length,3);
});
for(const body of [
 `const api={async check(){}};await(api.check()&&install());`,
 `const api={async check(){}};const alias=api;await(alias.check()&&install());`,
 `const api={async check(){}};const other={check:()=>false};Object.assign(other,{check:()=>true});await(api.check()&&install());`,
 `const api={async setup(){await install()}};await api.setup();`,
 `class Api{static async check(){}}await(Api.check()&&install());`,
 `class Api{async check(){}}const api=new Api();await(api.check()&&install());`,
])test('closed stable methods retain positive evidence: '+body,async t=>{
 assert.equal((await audit(t,body+'app.listen(3000);work();')).length,0);
});
test('shared stable method receiver index is reused for repeated conditions',async t=>{
 const body=`const api={async check(){}};`+Array.from({length:400},()=>`await(api.check()&&install());`).join('')+`app.listen(3000);work();`;
 assert.equal((await audit(t,body)).length,0);
});
