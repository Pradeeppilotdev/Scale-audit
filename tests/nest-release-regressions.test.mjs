import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {runAudit} from '../dist/runner.js';

async function audit(t, body) {
 const root=await mkdtemp('/tmp/scale-nest-release-');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(root+'/package.json',JSON.stringify({dependencies:{'@nestjs/core':'*'}}));
 await writeFile(root+'/main.ts',head+body);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));return report.findings;
}
const head=`import{Module,Controller,Get}from '@nestjs/common';import{NestFactory}from '@nestjs/core';@Controller('health')class Health{@Get()check(){return'ok'}}`;
const boot=`async function main(){const app=await NestFactory.create(AppModule);await app.listen(3000)}main();`;
const health=f=>f.some(x=>x.id==='missing-health-endpoint');
for(const body of [
 `const metadata={controllers:[Health]};const controllers=metadata.controllers;controllers.length=0;@Module(metadata)class AppModule{}`,
 `const metadata={controllers:[Health]};function clear(target){const controllers=target.controllers;controllers.pop()}clear(metadata);@Module(metadata)class AppModule{}`,
 `const metadata={controllers:[Health]};const controllers=metadata.controllers;@Module(metadata)class AppModule{}controllers.length=0;`,
])test('mutation through property alias invalidates live Nest controller array: '+body.slice(0,80),async t=>{
 assert.ok(health(await audit(t,body+boot)));
});
for(const body of [
 `const metadata={controllers:[Health]};const controllers=metadata.controllers;@Module(metadata)class AppModule{}`,
 `const metadata={controllers:[Health]};const controllers=metadata.controllers;function clear(){controllers.length=0}@Module(metadata)class AppModule{}`,
 `const metadata={controllers:[Health]};const other={controllers:[Health]};const controllers=other.controllers;controllers.length=0;@Module(metadata)class AppModule{}`,
])test('unmodified referenced Nest controller array retains health: '+body.slice(0,80),async t=>{
 assert.ok(!health(await audit(t,body+boot)));
});
test('root module supplied through helper parameter retains health',async t=>{
 assert.ok(!health(await audit(t,`@Module({controllers:[Health]})class AppModule{}async function start(root){const app=await NestFactory.create(root);await app.listen(3000)}start(AppModule);`)));
});
test('metadata supplied through helper parameter retains health',async t=>{
 assert.ok(!health(await audit(t,`async function start(metadata){@Module(metadata)class AppModule{}const app=await NestFactory.create(AppModule);await app.listen(3000)}start({controllers:[Health]});`)));
});
test('root module helper invocations cannot share healthy module evidence',async t=>{
 assert.ok(health(await audit(t,`@Module({controllers:[Health]})class Good{}@Module({})class Bad{}async function start(root,port){const app=await NestFactory.create(root);await app.listen(port)}start(Good,3000);start(Bad,4000);`)));
});
test('metadata helper invocations cannot share healthy controllers',async t=>{
 assert.ok(health(await audit(t,`async function start(metadata,port){@Module(metadata)class AppModule{}const app=await NestFactory.create(AppModule);await app.listen(port)}start({controllers:[Health]},3000);start({controllers:[]},4000);`)));
});
test('reassignment after decorator capture leaves reflected controller array intact',async t=>{
 assert.ok(!health(await audit(t,`const metadata={controllers:[Health]};@Module(metadata)class AppModule{}metadata.controllers=[];`+boot)));
});
test('mutation after copied array capture leaves copied controllers intact',async t=>{
 assert.ok(!health(await audit(t,`const controllers=[Health];const metadata={controllers:[...controllers]};controllers.length=0;@Module(metadata)class AppModule{}`+boot)));
});
test('mutation before copied array capture invalidates copied controller evidence',async t=>{
 assert.ok(health(await audit(t,`const controllers=[Health];controllers.length=0;const metadata={controllers:[...controllers]};@Module(metadata)class AppModule{}`+boot)));
});
for(const controllers of ['[...copy,...source]','[...source,...copy]'])test('healthy captured array remains evidence alongside mutated source: '+controllers,async t=>{
 assert.ok(!health(await audit(t,`const source=[Health];const copy=[...source];source.length=0;@Module({controllers:${controllers}})class AppModule{}`+boot)));
});
test('mixed copied and live arrays cannot resurrect a controller removed before every capture',async t=>{
 assert.ok(health(await audit(t,`const source=[Health];source.length=0;const copy=[...source];@Module({controllers:[...copy,...source]})class AppModule{}`+boot)));
});
