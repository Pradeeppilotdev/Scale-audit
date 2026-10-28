import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

const head=`import{Module,Controller,Get}from '@nestjs/common';import{NestFactory}from '@nestjs/core';@Controller('health')class Health{@Get()check(){return'ok'}}`;
const boot=`async function main(){const app=await NestFactory.create(AppModule);await app.listen(3000)}main();`;
async function audit(t,body){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-nest-capture-rc-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),JSON.stringify({dependencies:{'@nestjs/core':'*'}}));
 await writeFile(path.join(root,'main.ts'),head+body);
 const report=await runAudit(root);
 assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.some(f=>f.id==='missing-health-endpoint');
}
for(const initialization of [`static{metadata.controllers=[]}`,`static removed=(metadata.controllers=[])`])test('class initialization precedes Nest metadata capture: '+initialization,async t=>{
 assert.ok(await audit(t,`const metadata={controllers:[Health]};@Module(metadata)class AppModule{${initialization}}`+boot));
});
test('postclass metadata property reassignment leaves reflected original controllers intact',async t=>{
 assert.equal(await audit(t,`const metadata={controllers:[Health]};@Module(metadata)class AppModule{}metadata.controllers=[];`+boot),false);
});
test('postclass live controller array mutation still removes health evidence',async t=>{
 assert.ok(await audit(t,`const metadata={controllers:[Health]};@Module(metadata)class AppModule{}metadata.controllers.length=0;`+boot));
});
test('unrelated static initialization leaves Nest metadata intact',async t=>{
 assert.equal(await audit(t,`const metadata={controllers:[Health]};const unrelated={controllers:[Health]};@Module(metadata)class AppModule{static{unrelated.controllers=[]}}`+boot),false);
});
test('conditional static metadata writes retain the listening helper invocation',async t=>{
 assert.equal(await audit(t,`function start(remove,port){const metadata={controllers:[Health]};@Module(metadata)class AppModule{static{if(remove)metadata.controllers=[]}}async function main(){const app=await NestFactory.create(AppModule);await app.listen(port)}main()}start(false,3000);`),false);
});
test('executed static metadata write in one helper instance cannot be hidden by healthy instance',async t=>{
 assert.ok(await audit(t,`function start(remove,port){const metadata={controllers:[Health]};@Module(metadata)class AppModule{static{if(remove)metadata.controllers=[]}}async function main(){const app=await NestFactory.create(AppModule);await app.listen(port)}main()}start(false,3000);start(true,4000);`));
});
