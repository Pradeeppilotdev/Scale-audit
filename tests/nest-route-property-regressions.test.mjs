import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';
const imports=`import{Module,Controller,Get}from '@nestjs/common';import{NestFactory}from '@nestjs/core';`;
const boot=`async function main(){const app=await NestFactory.create(Root);await app.listen(3000)}main();`;
async function missingHealth(t,body,experimentalDecorators){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-nest-route-properties-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),JSON.stringify({dependencies:{'@nestjs/core':'*'}}));
 await writeFile(path.join(root,'main.ts'),imports+body);
 if(experimentalDecorators!==undefined)await writeFile(path.join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{experimentalDecorators}}));
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.some(f=>f.id==='missing-health-endpoint');
}
const controller=(prefix,suffix='')=>`@Controller(${prefix})class Health{@Get(${suffix})check(){return'ok'}}@Module({controllers:[Health]})class Root{}`;
for(const [prefix,suffix] of [
 [`paths.health`,``],
 [`paths['health']`,``],
 [`paths.api`,`paths.health`],
 [`paths.nested.health`,``],
 [`paths.health as const`,``],
 [`paths.health satisfies string`,``],
])test('property route literals retain controller/method health evidence: '+prefix+' / '+suffix,async t=>{
 assert.equal(await missingHealth(t,`const paths={health:'health',api:'api',nested:{health:'health'}};`+controller(prefix,suffix)+boot),false);
});
test('property route alias preserves its original captured string',async t=>{
 assert.equal(await missingHealth(t,`const paths={health:'health'};const prefix=paths.health;paths.health='users';`+controller('prefix')+boot),false);
});
test('property route follows a replacement made before decorator evaluation',async t=>{
 assert.ok(await missingHealth(t,`const paths={health:'health'};paths.health='users';`+controller('paths.health')+boot));
});
test('property route replacement can establish the current health path',async t=>{
 assert.equal(await missingHealth(t,`const paths={health:'users'};paths.health='health';`+controller('paths.health')+boot),false);
});
test('property route retains decorator argument capture after later mutation',async t=>{
 assert.equal(await missingHealth(t,`const paths={health:'health'};`+controller('paths.health')+`paths.health='users';`+boot),false);
});
test('conditional property route writes cannot retain stale health evidence',async t=>{
 assert.ok(await missingHealth(t,`const paths={health:'health'};if(enabled)paths.health='users';`+controller('paths.health')+boot));
});
test('unrelated property writes do not erase the health path',async t=>{
 assert.equal(await missingHealth(t,`const paths={health:'health',other:'old'};paths.other='users';`+controller('paths.health')+boot),false);
});
test('unhealthy property literals cannot borrow a healthy adjacent property',async t=>{
 assert.ok(await missingHealth(t,`const paths={health:'health',users:'users'};`+controller('paths.users')+boot));
});
test('property route bindings stay local to the helper invocation',async t=>{
 assert.equal(await missingHealth(t,`async function start(paths){${controller('paths.health')}const app=await NestFactory.create(Root);await app.listen(3000)}start({health:'health'});`),false);
});
test('different helper property paths cannot mix healthy route evidence',async t=>{
 assert.ok(await missingHealth(t,`async function start(paths,port){${controller('paths.health')}const app=await NestFactory.create(Root);await app.listen(port)}start({health:'health'},3000);start({health:'users'},4000);`));
});

for(const experimentalDecorators of [true,false])test('decorator mode preserves direct route-property evaluation ordering: '+experimentalDecorators,async t=>{
 const body=`const paths={health:'health'};@Controller(paths.health)class Health{static{paths.health='users'}@Get()check(){return'ok'}}@Module({controllers:[Health]})class Root{}`;
 assert.equal(await missingHealth(t,body+boot,experimentalDecorators),experimentalDecorators);
});
test('legacy static mutation does not change an earlier captured primitive route alias',async t=>{
 assert.equal(await missingHealth(t,`const paths={health:'health'};const prefix=paths.health;@Controller(prefix)class Health{static{paths.health='users'}@Get()check(){return'ok'}}@Module({controllers:[Health]})class Root{}`+boot,true),false);
});
test('legacy static mutation of an unrelated property leaves the route intact',async t=>{
 assert.equal(await missingHealth(t,`const paths={health:'health',other:'old'};@Controller(paths.health)class Health{static{paths.other='users'}@Get()check(){return'ok'}}@Module({controllers:[Health]})class Root{}`+boot,true),false);
});
test('legacy property-route capture excludes mutations after class completion',async t=>{
 assert.equal(await missingHealth(t,`const paths={health:'health'};${controller('paths.health')}paths.health='users';`+boot,true),false);
});
test('legacy method decorator property reads include class static mutations',async t=>{
 assert.ok(await missingHealth(t,`const paths={health:'health'};@Controller()class Health{static{paths.health='users'}@Get(paths.health)check(){return'ok'}}@Module({controllers:[Health]})class Root{}`+boot,true));
});
test('legacy nested route-property reads cannot retain a replaced inner object',async t=>{
 assert.ok(await missingHealth(t,`const paths={nested:{health:'health'}};@Controller(paths.nested.health)class Health{static{paths.nested={health:'users'}}@Get()check(){return'ok'}}@Module({controllers:[Health]})class Root{}`+boot,true));
});
