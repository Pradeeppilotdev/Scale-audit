import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

async function audit(t,files){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-nest-latest-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),JSON.stringify({type:'module',dependencies:{'@nestjs/core':'*',koa:'*'}}));
 for(const [rel,content] of Object.entries(files)){
  await mkdir(path.dirname(path.join(root,rel)),{recursive:true});
  await writeFile(path.join(root,rel),content);
 }
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));return report;
}
const has=(r,id,file)=>r.findings.some(f=>f.id===id&&(!file||f.file===file));
const head=`import {Controller,Get,Module} from '@nestjs/common';import {NestFactory} from '@nestjs/core';@Controller('health')class Health{@Get() check(){return 'ok'}}`;
const boot=`async function main(){const app=await NestFactory.create(AppModule);await app.listen(3000)}main();`;
for(const mutation of [
 `function clear(){metadata.controllers=[]}`,
 `function clear(){delete metadata.controllers}`,
 `function clear(){metadata.controllers.pop()}`,
])test(`uncalled metadata mutation cannot erase health evidence: ${mutation}`,async t=>{
 const report=await audit(t,{'main.ts':head+`const metadata={controllers:[Health]};${mutation}@Module(metadata)class AppModule{}`+boot});
 assert.ok(!has(report,'missing-health-endpoint'));
});
for(const body of [
 `const metadata={controllers:[Health]};function clear(target){target.controllers=[]}clear(metadata);@Module(metadata)class AppModule{}`,
 `const controllers=[Health];function clear(target){target.length=0}clear(controllers);@Module({controllers})class AppModule{}`,
 `const controllers=[Health];function clear(target){target.pop()}clear(controllers);@Module({controllers})class AppModule{}`,
 `const metadata={controllers:[Health]};function clear(target){Object.assign(target,{controllers:[]})}clear(metadata);@Module(metadata)class AppModule{}`,
 `const metadata={controllers:[Health]};function clear(target){delete target.controllers}clear(metadata);@Module(metadata)class AppModule{}`,
 `const metadata={controllers:[Health]};function clear(target){target.controllers.pop()}clear(metadata);@Module(metadata)class AppModule{}`,
 `const metadata={controllers:[Health]};if(enabled)metadata.controllers=[];@Module(metadata)class AppModule{}`,
])test(`called helper metadata mutation invalidates health evidence: ${body.slice(0,90)}`,async t=>{
 const report=await audit(t,{'main.ts':head+body+boot});assert.ok(has(report,'missing-health-endpoint'));
});
test('independent entry metadata mutation cannot poison server ownership',async t=>{
 const report=await audit(t,{
  'shared.ts':`import {Controller,Get}from '@nestjs/common';@Controller('health')export class Health{@Get() check(){return 'ok'}}export const metadata={controllers:[Health]};`,
  'main.ts':`import {Module}from '@nestjs/common';import {NestFactory}from '@nestjs/core';import {metadata}from './shared';@Module(metadata)class Root{}async function main(){const app=await NestFactory.create(Root);await app.listen(3000)}main();`,
  'maintenance.ts':`import {metadata}from './shared';metadata.controllers=[];`,
 });
 assert.ok(!has(report,'missing-health-endpoint','main.ts'));
});
test('executed same-entry imported helper mutation invalidates shared metadata',async t=>{
 const report=await audit(t,{
  'shared.ts':`import {Controller,Get}from '@nestjs/common';@Controller('health')export class Health{@Get() check(){return 'ok'}}export const metadata={controllers:[Health]};export function clear(target){target.controllers=[]}`,
  'main.ts':`import {Module}from '@nestjs/common';import {NestFactory}from '@nestjs/core';import {metadata,clear}from './shared';clear(metadata);@Module(metadata)class Root{}async function main(){const app=await NestFactory.create(Root);await app.listen(3000)}main();`,
 });
 assert.ok(has(report,'missing-health-endpoint','main.ts'));
});
test('mutating unrelated helper argument leaves metadata intact',async t=>{
 const report=await audit(t,{'main.ts':head+`const metadata={controllers:[Health]};const other={controllers:[Health]};function clear(target){target.controllers=[]}clear(other);@Module(metadata)class AppModule{}`+boot});
 assert.ok(!has(report,'missing-health-endpoint'));
});
for(const source of [
 `import Koa from 'koa';const service=new Koa();service.listen(3000);`,
 `import {createServer}from 'node:http';const service=createServer();service.listen(3000);`,
 `import {createServer as create}from 'https';const service=create();service.listen(3000);`,
 `import * as http from 'node:http';const service=http.createServer();service.listen(3000);`,
 `import https from 'node:https';const service=https.createServer();service.listen(3000);`,
])test(`server factories are discovered independently of receiver name: ${source}`,async t=>{
 const report=await audit(t,{'main.ts':source});assert.ok(has(report,'missing-graceful-shutdown'));
});
for(const source of [
 `class Koa{listen(){}}const service=new Koa();service.listen(3000);`,
 `function createServer(){return {listen(){}}}const service=createServer();service.listen(3000);`,
 `import {createServer}from './fake';const service=createServer();service.listen(3000);`,
])test(`unrelated server-like symbols do not establish a framework server: ${source}`,async t=>{
 const report=await audit(t,{'main.ts':source,'fake.ts':`export function createServer(){return {listen(){}}}`});assert.ok(!has(report,'missing-graceful-shutdown'));
});

test('metadata mutation in another helper instance does not poison the listening instance',async t=>{
 const report=await audit(t,{'main.ts':head+`function boot(clear,start){const metadata={controllers:[Health]};if(clear)metadata.controllers=[];if(start){@Module(metadata)class AppModule{}async function main(){const app=await NestFactory.create(AppModule);await app.listen(3000)}main();}}boot(true,false);boot(false,true);`});
 assert.ok(!has(report,'missing-health-endpoint'));
});
