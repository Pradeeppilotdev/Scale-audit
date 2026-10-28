import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';
const head=`import{Module,Controller,Get}from '@nestjs/common';import{NestFactory}from '@nestjs/core';@Controller('health')class Health{@Get()check(){return'ok'}}class Empty{}`;
const boot=`async function main(){const app=await NestFactory.create(Root);await app.listen(3000)}main();`;
async function missingHealth(t,legacy,body){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-nest-legacy-expression-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),JSON.stringify({dependencies:{'@nestjs/core':'*'}}));
 await writeFile(path.join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{experimentalDecorators:legacy}}));
 await writeFile(path.join(root,'main.ts'),head+body);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.some(f=>f.id==='missing-health-endpoint');
}
const delayedCases=[
 `const metadata={controllers:[Health]};@Module({...metadata})class Root{static{metadata.controllers=[]}}`,
 `@Module({controllers:[Health]})class Root{static{Health=Empty as any}}`,
 `const controllers=[Health];@Module({controllers:[...controllers]})class Root{static{controllers.length=0}}`,
];
for(const legacy of [true,false])for(const body of delayedCases)test(`inline metadata uses ${legacy?'legacy class completion':'modern expression'} snapshot: ${body.slice(0,85)}`,async t=>{
 assert.equal(await missingHealth(t,legacy,body+boot),legacy);
});
for(const legacy of [true,false])for(const body of [
 `const Original=Health;@Module({controllers:[Original]})class Root{static{Health=Empty as any}}`,
 `const controllers=[Health];@Module({controllers})class Root{static{Health=Empty as any}}`,
 `const metadata={controllers:[Health]};const copy={...metadata};@Module(copy)class Root{static{metadata.controllers=[]}}`,
 `const controllers=[Health];const copy=[...controllers];@Module({controllers:copy})class Root{static{controllers.length=0}}`,
])test(`prebuilt captures retain identity in ${legacy?'legacy':'modern'} mode: ${body.slice(0,85)}`,async t=>{
 assert.equal(await missingHealth(t,legacy,body+boot),false);
});
for(const legacy of [true,false])test(`live controller arrays remain mutable in ${legacy?'legacy':'modern'} mode`,async t=>{
 assert.ok(await missingHealth(t,legacy,`const controllers=[Health];@Module({controllers})class Root{static{controllers.length=0}}`+boot));
});
for(const legacy of [true,false])test(`post-class mutation does not alter copied inline metadata in ${legacy?'legacy':'modern'} mode`,async t=>{
 assert.equal(await missingHealth(t,legacy,`const controllers=[Health];@Module({controllers:[...controllers]})class Root{}controllers.length=0;`+boot),false);
});
test('legacy delayed inline metadata remains scoped to its helper invocation',async t=>{
 assert.ok(await missingHealth(t,true,`function boot(remove,port){const controllers=[Health];@Module({controllers:[...controllers]})class Root{static{if(remove)controllers.length=0}}async function main(){const app=await NestFactory.create(Root);await app.listen(port)}main()}boot(false,3000);boot(true,4000);`));
});
test('unrelated static mutation leaves legacy inline metadata healthy',async t=>{
 assert.equal(await missingHealth(t,true,`const controllers=[Health];const unrelated=[Health];@Module({controllers:[...controllers]})class Root{static{unrelated.length=0}}`+boot),false);
});
