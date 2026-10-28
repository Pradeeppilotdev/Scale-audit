import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {runAudit} from '../dist/runner.js';
async function audit(t,source){
 const root=await mkdtemp('/tmp/scale-property-reassignment-');t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(root+'/package.json',JSON.stringify({dependencies:{express:'*','@nestjs/core':'*'}}));
 await writeFile(root+'/main.ts',source);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));return report.findings;
}
const head=`import express from 'express';`;
const health=f=>f.some(x=>x.id==='missing-health-endpoint');
for(const body of [
 `const holder={app:express()};holder.app.get('/health',()=> 'ok');holder.app=express();holder.app.listen(3000);`,
 `const holder={app:express()};const old=holder.app;holder.app=express();old.get('/health',()=> 'ok');holder.app.listen(3000);`,
 `const holder={app:express()};holder['app'].get('/health',()=> 'ok');holder['app']=express();holder.app.listen(3000);`,
 `const holder={app:express()};holder.app.get('/health',()=> 'ok');if(enabled)holder.app=express();holder.app.listen(3000);`,
 `const holder={app:express()};holder.app.get('/health',()=> 'ok');function replace(target){target.app=express()}replace(holder);holder.app.listen(3000);`,
])test('replacement or uncertain server property cannot inherit stale health: '+body.slice(0,90),async t=>{
 assert.ok(health(await audit(t,head+body)));
});
for(const body of [
 `const holder={app:express()};holder.app=express();holder.app.get('/health',()=> 'ok');holder.app.listen(3000);`,
 `const holder={app:express()};const old=holder.app;old.get('/health',()=> 'ok');holder.app=express();old.listen(3000);`,
 `const holder={app:express()};holder.app.get('/health',()=> 'ok');const other={app:express()};other.app=express();holder.app.listen(3000);`,
 `const holder={app:express()};holder.app.get('/health',()=> 'ok');function replace(){holder.app=express()}holder.app.listen(3000);`,
 `const holder={app:express()};holder.app.get('/health',()=> 'ok');holder.app.listen(3000);holder.app=express();`,
])test('current or captured server property retains valid health: '+body.slice(0,90),async t=>{
 assert.ok(!health(await audit(t,head+body)));
});
test('server property discovery follows replacement of excluded collection',async t=>{
 const findings=await audit(t,head+`const holder={app:new Map()};holder.app=express();holder.app.listen(3000);`);
 assert.ok(health(findings));assert.ok(findings.some(f=>f.id==='missing-graceful-shutdown'));
});
const nest=`import{Module,Controller,Get}from '@nestjs/common';import{NestFactory}from '@nestjs/core';@Controller('health')class Health{@Get()check(){return'ok'}}`;
const boot=`async function main(){const app=await NestFactory.create(Root);await app.listen(3000)}main();`;
for(const body of [
 `const metadata={controllers:[Health]};@Module(metadata)class Root{}metadata.controllers=[];metadata.controllers.length=0;`,
 `const metadata={controllers:[Health]};@Module(metadata)class Root{}metadata.controllers=[];const alias=metadata.controllers;alias.length=0;`,
])test('mutating replacement metadata array does not alter captured original: '+body.slice(-80),async t=>{
 assert.ok(!health(await audit(t,nest+body+boot)));
});
test('old metadata array alias still invalidates captured original after property replacement',async t=>{
 assert.ok(health(await audit(t,nest+`const metadata={controllers:[Health]};const old=metadata.controllers;@Module(metadata)class Root{}metadata.controllers=[];old.length=0;`+boot)));
});

test('helper property replacement uses its current argument binding',async t=>{
 assert.ok(!health(await audit(t,head+`const holder={app:express()};function boot(target,next,route){target.app=next;target.app.get(route,()=> 'ok');target.app.listen(3000)}boot(holder,express(),'/health');`)));
});
test('helper property replacement cannot mix route bindings from separate invocations',async t=>{
 assert.ok(health(await audit(t,head+`const holder={app:express()};function boot(target,next,route){target.app=next;target.app.get(route,()=> 'ok');target.app.listen(3000)}boot(holder,express(),'/health');boot(holder,express(),'/users');`)));
});
