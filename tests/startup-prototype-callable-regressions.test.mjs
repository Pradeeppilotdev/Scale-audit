import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

async function findings(t,body){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-prototype-callable-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),'{"type":"module","dependencies":{"express":"*"}}');
 await writeFile(path.join(root,'main.ts'),`import express from 'express';const app=express();async function install(){await load();process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{});app.get('/health',()=> 'ok')}async function work(){throw Error()}${body}`);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.filter(f=>['missing-health-endpoint','missing-graceful-shutdown','missing-rejection-handler'].includes(f.id));
}
for(const mutation of [
 `Object.assign(Api.prototype,{check:()=>false});`,
 `Object.defineProperty(Api.prototype,'check',{value:()=>false});`,
 `Object.defineProperties(Api.prototype,{check:{value:()=>false}});`,
 `function replace(target){target.check=()=>false}replace(Api.prototype);`,
 `mutate(Api.prototype);`,
 `const proto=Api.prototype;Object.assign(proto,{check:()=>false});`,
 `const Alias=Api;Object.assign(Alias.prototype,{check:()=>false});`,
 `Object.assign(Api['prototype'],{check:()=>false});`,
 `Object.assign((Api.prototype satisfies any),{check:()=>false});`,
 `const registry={nested:{proto:Api.prototype}};Object.assign(registry.nested.proto,{check:()=>false});`,
 `mutate({nested:{proto:Api.prototype}});`,
 `const aliases=[Api.prototype];aliases[0].check=()=>false;`,
 `const {prototype:proto}=Api;mutate(proto);`,
 `export const proto=Api.prototype;`,
 `declare const key:string;mutate(Api[key]);`,
 `Api.prototype.check=()=>false;`,
])test('prototype mutation or escape invalidates async callable identity: '+mutation,async t=>{
 const body=`class Api{async check(){}}${mutation}const api=new Api();await(api.check()&&install());app.listen(3000);work();`;
 assert.equal((await findings(t,body)).length,3);
});
for(const body of [
 `class Api{async check(){}}const registry={nested:{Api}};const api=new registry.nested.Api();Object.assign(api.constructor.prototype,{check:()=>false});await(api.check()&&install());`,
 `class Api{async check(){}}const api=new Api();Object.assign(api.constructor.prototype,{check:()=>false});await(api.check()&&install());`,
 `class Api{async check(){}}const api=new Api();const ctor=api['constructor'];Object.defineProperty(ctor['prototype'],'check',{value:()=>false});await(api.check()&&install());`,
 `const Api=class{async check(){}};Object.assign(Api.prototype,{check:()=>false});const api=new Api();await(api.check()&&install());`,
 `class Api{async setup(){await install()}}Object.assign(Api.prototype,{setup:async()=>{}});const api=new Api();await api.setup();`,
 `class Api{setup(){process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{});app.get('/health',()=> 'ok')}}Object.assign(Api.prototype,{setup:()=>{}});new Api().setup();`,
])test('prototype replacement cannot donate stale setup: '+body,async t=>{
 assert.equal((await findings(t,body+'app.listen(3000);work();')).length,3);
});
for(const body of [
 `class Api{async check(){}}const api=new Api();await(api.check()&&install());`,
 `class Api{static async check(){}}await(Api.check()&&install());`,
 `class Api{async check(){}}const proto=Api.prototype;await(proto.check()&&install());`,
 `const Api=class{async check(){}};const proto=Api['prototype'];await(proto.check()&&install());`,
 `class Api{async check(){}}class Other{async check(){}}Object.assign(Other.prototype,{check:()=>false});const api=new Api();await(api.check()&&install());`,
 `class Other{async check(){}}Object.assign(Other.prototype,{check:()=>false});const api={async check(){}};await(api.check()&&install());`,
])test('closed unrelated callable identities remain proven: '+body,async t=>{
 assert.equal((await findings(t,body+'app.listen(3000);work();')).length,0);
});
test('closed prototype aliases reuse mutation facts across repeated conditions',async t=>{
 const body=`class Api{async check(){}}const proto=Api.prototype;`+'await(proto.check()&&install());'.repeat(400)+'app.listen(3000);work();';
 assert.equal((await findings(t,body)).length,0);
});
