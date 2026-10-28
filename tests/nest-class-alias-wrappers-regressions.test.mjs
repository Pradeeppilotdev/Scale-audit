import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

const head=`import{Module,Controller,Get}from '@nestjs/common';import{NestFactory}from '@nestjs/core';@Controller('health')class Health{@Get()check(){return'ok'}}class Empty{}`;
const boot=`async function main(){const app=await NestFactory.create(Root);await app.listen(3000)}main();`;
async function missingHealth(t,body){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-nest-class-wrappers-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),JSON.stringify({dependencies:{'@nestjs/core':'*'}}));
 await writeFile(path.join(root,'main.ts'),head+body);
 const report=await runAudit(root);
 assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.some(f=>f.id==='missing-health-endpoint');
}
for(const expression of ['registry.Health',`registry['Health']`])test('controller class captured from an object property retains health: '+expression,async t=>{
 assert.equal(await missingHealth(t,`const registry={Health};@Module({controllers:[${expression}]})class Root{}`+boot),false);
});
test('controller class property alias retains health',async t=>{
 assert.equal(await missingHealth(t,`const registry={Health};const ControllerAlias=registry.Health;@Module({controllers:[ControllerAlias]})class Root{}`+boot),false);
});
test('controller class alias preserves its earlier capture after property replacement',async t=>{
 assert.equal(await missingHealth(t,`const registry={Health};const ControllerAlias=registry.Health;registry.Health=Empty;@Module({controllers:[ControllerAlias]})class Root{}`+boot),false);
});
test('controller class property follows replacement before capture',async t=>{
 assert.ok(await missingHealth(t,`const registry={Health};registry.Health=Empty;@Module({controllers:[registry.Health]})class Root{}`+boot));
});
test('uncertain class property replacement cannot establish healthy controller identity',async t=>{
 assert.ok(await missingHealth(t,`const registry={Health};if(enabled)registry.Health=Empty;@Module({controllers:[registry.Health]})class Root{}`+boot));
});
test('unhealthy controller property cannot borrow another registry property',async t=>{
 assert.ok(await missingHealth(t,`const registry={Health,Empty};@Module({controllers:[registry.Empty]})class Root{}`+boot));
});
test('controller class property inside helper retains supplied registry binding',async t=>{
 assert.equal(await missingHealth(t,`async function start(registry){const Alias=registry.Health;@Module({controllers:[Alias]})class Root{}const app=await NestFactory.create(Root);await app.listen(3000)}start({Health});`),false);
});
test('helper controller class properties cannot mix healthy registry invocations',async t=>{
 assert.ok(await missingHealth(t,`async function start(registry,port){@Module({controllers:[registry.Health]})class Root{}const app=await NestFactory.create(Root);await app.listen(port)}start({Health},3000);start({Health:Empty},4000);`));
});
for(const body of [
 `const controllers=[Health] satisfies any;@Module({controllers})class Root{}`,
 `const registry={controllers:[Health]};@Module({controllers:registry.controllers satisfies any})class Root{}`,
 `const registry={Health};@Module({controllers:[registry.Health satisfies any]})class Root{}`,
])test('satisfies wrappers preserve runtime metadata evidence: '+body.slice(0,75),async t=>{
 assert.equal(await missingHealth(t,body+boot),false);
});
test('satisfies wrappers cannot manufacture a healthy controller',async t=>{
 assert.ok(await missingHealth(t,`const controllers=[Empty] satisfies any;@Module({controllers})class Root{}`+boot));
});
test('satisfies array wrapper retains live mutation tracking',async t=>{
 assert.ok(await missingHealth(t,`const controllers=[Health] satisfies any;controllers.length=0;@Module({controllers})class Root{}`+boot));
});
