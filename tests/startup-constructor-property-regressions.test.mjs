import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

async function findings(t,body){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-constructor-property-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),'{"type":"module","dependencies":{"express":"*"}}');
 await writeFile(path.join(root,'main.ts'),`import express from 'express';const app=express();async function install(){await load();process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{});app.get('/health',()=> 'ok')}async function work(){throw Error()}${body}app.listen(3000);work();`);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.filter(f=>['missing-health-endpoint','missing-graceful-shutdown','missing-rejection-handler'].includes(f.id));
}
const constructors=[
 [`const registry={Api:class{async check(){}}};`,'registry.Api'],
 [`class Api{async check(){}}const registry={Api};`,'registry.Api'],
 [`class Api{async check(){}}const registry={nested:{Api}};`,"registry['nested']['Api']"],
 [`const Api=class{async check(){}};const registry={nested:{Api}};const Alias=registry.nested.Api;`,'Alias'],
 [`const registry={Api:class{async check(){}}} satisfies any;`,'(registry.Api satisfies any)'],
];
for(const [declaration,constructor]of constructors)for(const mutation of [
 `Object.assign(api,{check:()=>false});`,
 `Object.defineProperty(api,'check',{value:()=>false});`,
 `function replace(target){target.check=()=>false}replace(api);`,
 `mutate({nested:{api}});`,
])test('property constructor allocation cannot keep stale async identity: '+constructor+' '+mutation,async t=>{
 assert.equal((await findings(t,`${declaration}const api=new ${constructor}();${mutation}await(api.check()&&install());`)).length,3);
});
for(const [declaration,constructor]of constructors)test('stable property constructor remains proven: '+constructor,async t=>{
 assert.equal((await findings(t,`${declaration}const api=new ${constructor}();await(api.check()&&install());`)).length,0);
});
for(const prefix of ['', 'async '])test('property constructor mutation cannot donate stale setup helper: '+(prefix||'sync'),async t=>{
 const body=`const registry={Api:class{${prefix}setup(){${prefix?'await load();':''}process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{});app.get('/health',()=> 'ok')}}};const api=new registry.Api();Object.assign(api,{setup(){}});${prefix?'await ':''}api.setup();`;
 assert.equal((await findings(t,body)).length,3);
});
test('mutating an instance from an unrelated constructor preserves stable identity',async t=>{
 const body=`const registry={Api:class{async check(){}},Other:class{async check(){}}};const other=new registry.Other();Object.assign(other,{check:()=>false});const api=new registry.Api();await(api.check()&&install());`;
 assert.equal((await findings(t,body)).length,0);
});
test('property constructor mutation facts remain shared across repeated conditions',async t=>{
 const body=`const registry={Api:class{async check(){}}};const api=new registry.Api();Object.assign(api,{check:()=>false});`+'await(api.check()&&install());'.repeat(400);
 assert.equal((await findings(t,body)).length,3);
});
