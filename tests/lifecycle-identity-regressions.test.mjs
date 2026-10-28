import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

async function audit(t, source, files={}) {
  const root=await mkdtemp(path.join(os.tmpdir(),'scale-lifecycle-identity-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'package.json'),JSON.stringify({private:true,dependencies:{express:'*','@nestjs/core':'*'}}));
  for(const [rel,content] of Object.entries({'app.ts':source,...files})) {
    await mkdir(path.dirname(path.join(root,rel)),{recursive:true});await writeFile(path.join(root,rel),content);
  }
  const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));return report.findings;
}
const express=`import express from 'express';`;
const health=f=>f.filter(f=>f.id==='missing-health-endpoint');
const shutdown=f=>f.filter(f=>f.id==='missing-graceful-shutdown');
const nest=`import {Controller,Get,Module} from '@nestjs/common';import {NestFactory} from '@nestjs/core';@Controller('health') class Health{@Get() check(){return 'ok'}}`;
const boot=`async function main(){const app=await NestFactory.create(AppModule);await app.listen(3000)}main();`;

test('reassigned server cannot inherit routes from its previous allocation',async t=>{
  const f=await audit(t,express+`let app=express();app.get('/health',()=> 'ok');app=express();app.listen(3000);`);assert.equal(health(f).length,1);
});
test('route on the reassigned allocation is accepted',async t=>{
  const f=await audit(t,express+`let app=express();app=express();app.get('/health',()=> 'ok');app.listen(3000);`);assert.equal(health(f).length,0);
});
test('unwritten let receiver can establish health',async t=>{
  const f=await audit(t,express+`let app=express();app.get('/health',()=> 'ok');app.listen(3000);`);assert.equal(health(f).length,0);
});
test('captured alias retains its old allocation after reassignment',async t=>{
  const f=await audit(t,express+`let app=express();const alias=app;app=express();alias.get('/health',()=> 'ok');app.listen(3000);`);assert.equal(health(f).length,1);
});
test('alias captured after reassignment protects the current instance',async t=>{
  const f=await audit(t,express+`let app=express();app=express();const alias=app;alias.get('/health',()=> 'ok');app.listen(3000);`);assert.equal(health(f).length,0);
});
test('conditional reassignment cannot prove the listening instance is protected',async t=>{
  const f=await audit(t,express+`let app=express();app.get('/health',()=> 'ok');if(enabled)app=express();app.listen(3000);`);assert.equal(health(f).length,1);
});
test('same-text receivers in separate scopes cannot share shutdown hooks',async t=>{
  const f=await audit(t,nest+`@Module({})class AppModule{}async function first(){const app=await NestFactory.create(AppModule);app.enableShutdownHooks();await app.listen(3000);}async function second(){const app=await NestFactory.create(AppModule);await app.listen(4000);}first();second();`);assert.equal(shutdown(f).length,1);
});
test('unrelated object with shutdown method is not Nest hook evidence',async t=>{
  const f=await audit(t,express+`const app=express();function unrelated(){const app={enableShutdownHooks(){}};app.enableShutdownHooks();}unrelated();app.listen(3000);`);assert.equal(shutdown(f).length,1);
});
test('alias of the same Nest application can enable its hooks',async t=>{
  const f=await audit(t,nest+`@Module({})class AppModule{}async function main(){const app=await NestFactory.create(AppModule);const alias=app;alias.enableShutdownHooks();await app.listen(3000);}main();`);assert.equal(shutdown(f).length,0);
});
test('parameterized local route helper associates its argument with the server',async t=>{
  const f=await audit(t,express+`const app=express();function setup(target){target.get('/health',()=> 'ok')}setup(app);app.listen(3000);`);assert.equal(health(f).length,0);
});
test('route helper called for a different app cannot protect the listener',async t=>{
  const f=await audit(t,express+`const app=express();const other=express();function setup(target){target.get('/health',()=> 'ok')}setup(other);app.listen(3000);`);assert.equal(health(f).length,1);
});
test('cross-file helper arguments retain allocation identity',async t=>{
  const f=await audit(t,express+`import {setup} from './setup';const app=express();setup(app);app.listen(3000);`,{'setup.ts':`export function setup(target){target.get('/health',()=> 'ok')}`});assert.equal(health(f).length,0);
});
for(const [name,metadata,expected]of [
  ['later spread removes controller',`{controllers:[Health],...{controllers:[]}}`,1],
  ['later explicit property restores controller',`{...{controllers:[]},controllers:[Health]}`,0],
  ['duplicate property follows last write',`{controllers:[Health],controllers:[]}`,1],
  ['unknown later spread invalidates proof',`{controllers:[Health],...unknown}`,1],
  ['known explicit property after unknown spread restores proof',`{...unknown,controllers:[Health]}`,0],
  ['nested spread preserves controller',`{...{...{controllers:[Health]}}}`,0],
])test(`Nest ${name}`,async t=>{
  const f=await audit(t,nest+`@Module(${metadata})class AppModule{}`+boot);assert.equal(health(f).length,expected);
});
test('Nest metadata aliases are resolved without executing code',async t=>{
  const f=await audit(t,nest+`const metadata={controllers:[Health]};@Module(metadata)class AppModule{}`+boot);assert.equal(health(f).length,0);
});
test('Nest imports overridden to empty cannot leak child health controllers',async t=>{
  const f=await audit(t,nest+`@Module({controllers:[Health]})class Child{}@Module({imports:[Child],...{imports:[]}})class AppModule{}`+boot);assert.equal(health(f).length,1);
});

test('reassigned Nest metadata cannot retain its initial controllers',async t=>{
  const f=await audit(t,nest+`let metadata={controllers:[Health]};metadata={controllers:[]};@Module(metadata)class AppModule{}`+boot);assert.equal(health(f).length,1);
});
test('reassigned Nest metadata accepts its current controllers',async t=>{
  const f=await audit(t,nest+`let metadata={controllers:[]};metadata={controllers:[Health]};@Module(metadata)class AppModule{}`+boot);assert.equal(health(f).length,0);
});
test('reassigned metadata spread is resolved at its capture location',async t=>{
  const f=await audit(t,nest+`let spread={controllers:[Health]};spread={controllers:[]};@Module({...spread})class AppModule{}`+boot);assert.equal(health(f).length,1);
});

test('Nest listener aliases do not rely on conventional receiver names',async t=>{
  const f=await audit(t,nest+`@Module({})class AppModule{}async function main(){const service=await NestFactory.create(AppModule);const renamed=service;await renamed.listen(3000);}main();`);assert.equal(health(f).length,1);assert.equal(shutdown(f).length,1);
});

test('ambiguous helper server arguments remain visible as low-confidence candidates',async t=>{
  const f=await audit(t,express+`const first=express();const second=express();function start(target){target.listen(3000)}start(first);start(second);`);
  assert.equal(health(f).length,1);assert.equal(health(f)[0].confidence,'low');assert.equal(shutdown(f).length,1);
});

test('conditional listener accepts safeguards installed in the same startup branch',async t=>{
  const f=await audit(t,express+`if(enabled){const app=express();app.get('/health',()=> 'ok');app.listen(3000);process.on('SIGTERM',()=>{});}`);
  assert.equal(health(f).length,0);assert.equal(shutdown(f).length,0);
});
test('conditional listener cannot borrow safeguards from its alternate branch',async t=>{
  const f=await audit(t,express+`const app=express();if(enabled){app.listen(3000);}else{app.get('/health',()=> 'ok');process.on('SIGTERM',()=>{});}`);
  assert.equal(health(f).length,1);assert.equal(shutdown(f).length,1);
});
test('conditional listener cannot borrow safeguards from an independent condition',async t=>{
  const f=await audit(t,express+`const app=express();if(first){app.listen(3000);}if(second){app.get('/health',()=> 'ok');process.on('SIGTERM',()=>{});}`);
  assert.equal(health(f).length,1);assert.equal(shutdown(f).length,1);
});
test('more narrowly conditional safeguards do not protect the surrounding listener branch',async t=>{
  const f=await audit(t,express+`const app=express();if(first){if(second){app.get('/health',()=> 'ok');process.on('SIGTERM',()=>{});}app.listen(3000);}`);
  assert.equal(health(f).length,1);assert.equal(shutdown(f).length,1);
});
test('unconditional safeguards protect a conditional listener',async t=>{
  const f=await audit(t,express+`const app=express();app.get('/health',()=> 'ok');process.on('SIGTERM',()=>{});if(enabled){app.listen(3000);}`);
  assert.equal(health(f).length,0);assert.equal(shutdown(f).length,0);
});

test('safeguards after startup validation protect a listener reached after the same validation',async t=>{
  const f=await audit(t,express+`function validate(){if(invalid)throw Error('bad')}if(enabled){try{validate()}catch(error){process.exit(1)}const app=express();app.get('/health',()=> 'ok');app.listen(3000);process.on('SIGTERM',()=>{});}`);
  assert.equal(health(f).length,0);assert.equal(shutdown(f).length,0);
});
