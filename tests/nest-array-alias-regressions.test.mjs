import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

const head=`import{Module,Controller,Get}from '@nestjs/common';import{NestFactory}from '@nestjs/core';@Controller('health')class Health{@Get()check(){return'ok'}}`;
const boot=`async function main(){const app=await NestFactory.create(Root);await app.listen(3000)}main();`;
async function missingHealth(t,body){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-nest-array-alias-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),JSON.stringify({dependencies:{'@nestjs/core':'*'}}));
 await writeFile(path.join(root,'main.ts'),head+body);
 const report=await runAudit(root);
 assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.some(f=>f.id==='missing-health-endpoint');
}
for(const expression of ['metadata.controllers',`metadata['controllers']`])test('direct property controller array retains healthy module: '+expression,async t=>{
 assert.equal(await missingHealth(t,`const metadata={controllers:[Health]};@Module({controllers:${expression}})class Root{}`+boot),false);
});
test('immutable alias of property controller array retains health',async t=>{
 assert.equal(await missingHealth(t,`const metadata={controllers:[Health]};const controllers=metadata.controllers;@Module({controllers})class Root{}`+boot),false);
});
test('property controller array aliases retain original capture after replacement',async t=>{
 assert.equal(await missingHealth(t,`const metadata={controllers:[Health]};const controllers=metadata.controllers;metadata.controllers=[];@Module({controllers})class Root{}`+boot),false);
});
test('property controller array read follows replacement before capture',async t=>{
 assert.ok(await missingHealth(t,`const metadata={controllers:[Health]};metadata.controllers=[];const controllers=metadata.controllers;@Module({controllers})class Root{}`+boot));
});
test('property controller array read with no controllers cannot borrow another property',async t=>{
 assert.ok(await missingHealth(t,`const metadata={controllers:[],other:[Health]};@Module({controllers:metadata.controllers})class Root{}`+boot));
});
test('mutation before property-array capture removes health evidence',async t=>{
 assert.ok(await missingHealth(t,`const metadata={controllers:[Health]};metadata.controllers.length=0;const controllers=metadata.controllers;@Module({controllers})class Root{}`+boot));
});
test('mutation after alias capture still affects live controller array',async t=>{
 assert.ok(await missingHealth(t,`const metadata={controllers:[Health]};const controllers=metadata.controllers;@Module({controllers})class Root{}metadata.controllers.length=0;`+boot));
});
test('spread property array keeps its copied controllers after source mutation',async t=>{
 assert.equal(await missingHealth(t,`const metadata={controllers:[Health]};const controllers=[...metadata.controllers];metadata.controllers.length=0;@Module({controllers})class Root{}`+boot),false);
});
test('spread property array cannot restore controllers removed before copying',async t=>{
 assert.ok(await missingHealth(t,`const metadata={controllers:[Health]};metadata.controllers.length=0;const controllers=[...metadata.controllers];@Module({controllers})class Root{}`+boot));
});
test('property-array metadata inside helper retains listener invocation',async t=>{
 assert.equal(await missingHealth(t,`async function start(metadata){const controllers=metadata.controllers;@Module({controllers})class Root{}const app=await NestFactory.create(Root);await app.listen(3000)}start({controllers:[Health]});`),false);
});
test('helper property-array invocations cannot mix healthy controller evidence',async t=>{
 assert.ok(await missingHealth(t,`async function start(metadata,port){const controllers=metadata.controllers;@Module({controllers})class Root{}const app=await NestFactory.create(Root);await app.listen(port)}start({controllers:[Health]},3000);start({controllers:[]},4000);`));
});
