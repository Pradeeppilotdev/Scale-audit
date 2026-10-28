import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';
const imports=`import{Module,Controller,Get}from '@nestjs/common';import{NestFactory}from '@nestjs/core';`;
const head=imports+`@Controller('health')class Health{@Get()check(){return'ok'}}class Empty{}`;
const boot=`async function main(){const app=await NestFactory.create(Root);await app.listen(3000)}main();`;
async function missingHealth(t,body,prelude=head){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-nest-class-capture-literals-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),JSON.stringify({dependencies:{'@nestjs/core':'*'}}));
 await writeFile(path.join(root,'main.ts'),prelude+body);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.some(f=>f.id==='missing-health-endpoint');
}
for(const body of [
 `Health=Empty as any;@Module({controllers:[Health]})class Root{}`,
 `Health=Empty as any;const registry={Health};@Module({controllers:[registry.Health]})class Root{}`,
 `Health=Empty as any;const Alias=Health;@Module({controllers:[Alias]})class Root{}`,
 `if(enabled)Health=Empty as any;@Module({controllers:[Health]})class Root{}`,
])test('class binding replacement cannot retain stale controller evidence: '+body.slice(0,90),async t=>{
 assert.ok(await missingHealth(t,body+boot));
});
for(const body of [
 `const registry={Health};Health=Empty as any;@Module({controllers:[registry.Health]})class Root{}`,
 `const controllers=[Health];Health=Empty as any;@Module({controllers})class Root{}`,
 `const Alias=Health;Health=Empty as any;@Module({controllers:[Alias]})class Root{}`,
 `@Module({controllers:[Health]})class Root{}Health=Empty as any;`,
 `function replace(){Health=Empty as any}@Module({controllers:[Health]})class Root{}`,
])test('captured original controller survives later binding replacement: '+body.slice(0,90),async t=>{
 assert.equal(await missingHealth(t,body+boot),false);
});
test('helper class binding writes remain isolated by invocation',async t=>{
 assert.ok(await missingHealth(t,`async function start(change,port){@Controller('health')class Local{@Get()check(){return'ok'}}if(change)Local=Empty as any;@Module({controllers:[Local]})class Root{}const app=await NestFactory.create(Root);await app.listen(port)}start(false,3000);start(true,4000);`));
});
test('unexecuted helper class write leaves healthy invocation unchanged',async t=>{
 assert.equal(await missingHealth(t,`async function start(change){@Controller('health')class Local{@Get()check(){return'ok'}}if(change)Local=Empty as any;@Module({controllers:[Local]})class Root{}const app=await NestFactory.create(Root);await app.listen(3000)}start(false);`),false);
});
for(const [prefix,suffix] of [
 [`'health' as const`,``],
 [`('api' as const)`,`'health' satisfies string`],
 [`('health' satisfies string)`,``],
 [`'health'!`,``],
])test('erased route wrappers retain controller and method path evidence: '+prefix+' / '+suffix,async t=>{
 const declarations=`@Controller(${prefix})class Wrapped{@Get(${suffix})check(){return'ok'}}@Module({controllers:[Wrapped]})class Root{}`;
 assert.equal(await missingHealth(t,declarations+boot,imports),false);
});
test('stable literal aliases compose controller and method paths',async t=>{
 assert.equal(await missingHealth(t,`const PREFIX='api' as const;const PATH='health' satisfies string;@Controller(PREFIX)class Wrapped{@Get(PATH)check(){return'ok'}}@Module({controllers:[Wrapped]})class Root{}`+boot,imports),false);
});
test('mutable route alias cannot retain stale health path',async t=>{
 assert.ok(await missingHealth(t,`let prefix='health';prefix='users';@Controller(prefix)class Wrapped{@Get()check(){return'ok'}}@Module({controllers:[Wrapped]})class Root{}`+boot,imports));
});
test('wrapped nonhealth path does not become a health endpoint',async t=>{
 assert.ok(await missingHealth(t,`@Controller('users' as const)class Wrapped{@Get()check(){return'ok'}}@Module({controllers:[Wrapped]})class Root{}`+boot,imports));
});
test('helper supplied literal path retains its current invocation binding',async t=>{
 assert.equal(await missingHealth(t,`async function start(prefix){@Controller(prefix)class Wrapped{@Get()check(){return'ok'}}@Module({controllers:[Wrapped]})class Root{}const app=await NestFactory.create(Root);await app.listen(3000)}start('health' as const);`,imports),false);
});
