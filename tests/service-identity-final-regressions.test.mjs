import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {runAudit} from '../dist/runner.js';
async function audit(t,source){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-final-identity-fix-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),JSON.stringify({dependencies:{express:'*','@nestjs/core':'*'}}));await writeFile(path.join(root,'app.ts'),source);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));return report.findings;
}
const has=(f,id)=>f.some(x=>x.id===id);
for(const declaration of ['let service=null;service=express();service.listen(3000);','let app=new Map();app=express();app.listen(3000);'])test(`server discovery follows current allocation: ${declaration}`,async t=>{
 const findings=await audit(t,`import express from 'express';${declaration}`);assert.ok(has(findings,'missing-health-endpoint'));assert.ok(has(findings,'missing-graceful-shutdown'));
});
test('server reassigned to a collection is not a current server',async t=>{
 const findings=await audit(t,`import express from 'express';let app=express();app=new Map();app.listen(3000);`);assert.ok(!has(findings,'missing-health-endpoint'));assert.ok(!has(findings,'missing-graceful-shutdown'));
});
const nestHead=`import {Controller,Get,Module} from '@nestjs/common';import {NestFactory} from '@nestjs/core';@Controller('health')class Health{@Get() check(){return 'ok'}}`;
const boot=`async function main(){const app=await NestFactory.create(AppModule);await app.listen(3000)}main();`;
for(const metadata of [
 `const metadata={controllers:[Health]};metadata.controllers=[];@Module(metadata)class AppModule{}`,
 `const controllers=[Health];controllers.length=0;@Module({controllers})class AppModule{}`,
 `const controllers=[Health];controllers.pop();@Module({controllers})class AppModule{}`,
 `const metadata={controllers:[Health]};const alias=metadata;alias.controllers=[];@Module(metadata)class AppModule{}`,
 `const metadata={controllers:[Health]};delete metadata.controllers;@Module(metadata)class AppModule{}`,
 `const metadata={controllers:[Health]};Object.assign(metadata,{controllers:[]});@Module(metadata)class AppModule{}`,
])test(`visible metadata mutation invalidates controller proof: ${metadata.slice(0,65)}`,async t=>{
 const findings=await audit(t,nestHead+metadata+boot);assert.ok(has(findings,'missing-health-endpoint'));
});
test('unrelated object and array mutations do not invalidate Nest metadata',async t=>{
 const findings=await audit(t,nestHead+`const metadata={controllers:[Health]};const other={controllers:[Health]};other.controllers=[];const unrelated=[Health];unrelated.length=0;@Module(metadata)class AppModule{}`+boot);assert.ok(!has(findings,'missing-health-endpoint'));
});
test('mutating old metadata allocation does not invalidate a replacement',async t=>{
 const findings=await audit(t,nestHead+`let metadata={controllers:[Health]};const old=metadata;metadata={controllers:[Health]};old.controllers=[];@Module(metadata)class AppModule{}`+boot);assert.ok(!has(findings,'missing-health-endpoint'));
});
test('literal route path passed through a helper remains health evidence',async t=>{
 const findings=await audit(t,`import express from 'express';const app=express();function setup(target,route){target.get(route,()=> 'ok')}setup(app,'/health');app.listen(3000);`);assert.ok(!has(findings,'missing-health-endpoint'));
});
test('helper non-health literal path does not establish health',async t=>{
 const findings=await audit(t,`import express from 'express';const app=express();function setup(target,route){target.get(route,()=> 'ok')}setup(app,'/users');app.listen(3000);`);assert.ok(has(findings,'missing-health-endpoint'));
});
test('repeated equivalent helper receiver and path preserve health evidence',async t=>{
 const findings=await audit(t,`import express from 'express';const app=express();function setup(target,route){target.get(route,()=> 'ok')}setup(app,'/health');setup(app,'/health');app.listen(3000);`);assert.ok(!has(findings,'missing-health-endpoint'));
});
test('different helper invocations do not mix receiver and health path',async t=>{
 const findings=await audit(t,`import express from 'express';const app=express(),other=express();function setup(target,route){target.get(route,()=> 'ok')}setup(other,'/health');setup(app,'/users');app.listen(3000);`);assert.ok(has(findings,'missing-health-endpoint'));
});
test('different helper invocations do not mix receiver and callback',async t=>{
 const findings=await audit(t,`import express from 'express';const app=express(),other=express();function setup(target,handler){target.get('/health',handler)}setup(other,()=> 'ok');setup(app,null);app.listen(3000);`);assert.ok(has(findings,'missing-health-endpoint'));
});
