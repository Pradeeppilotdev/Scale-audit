import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

const imports=`import{Module,Controller,Get}from '@nestjs/common';import{NestFactory}from '@nestjs/core';`;
const head=imports+`@Controller('health')class Health{@Get()check(){return'ok'}}class Empty{}`;
const boot=`async function main(){const app=await NestFactory.create(Root);await app.listen(3000)}main();`;
async function missingHealth(t,body){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-nest-restored-class-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),JSON.stringify({dependencies:{'@nestjs/core':'*'}}));
 await writeFile(path.join(root,'main.ts'),head+body);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.some(f=>f.id==='missing-health-endpoint');
}
for(const body of [
 `const Original=Health;Health=Empty as any;Health=Original;`,
 `const registry={Original:Health};Health=Empty as any;Health=registry.Original;`,
 `Health=Health;`,
 `const First=Health;const Second=First;Health=Empty as any;Health=Second;`,
 `const Original=Health;Health=Empty as any;Health=Original;Health=Health;`,
 `let Original:any;Original=Health;Health=Empty as any;Health=Original;`,
])test('healthy constructor restoration retains its earlier snapshot: '+body,async t=>{
 assert.equal(await missingHealth(t,body+`@Module({controllers:[Health]})class Root{}`+boot),false);
});
for(const body of [
 `const Original=Empty;Health=Original as any;`,
 `Health=Empty as any;Health=Health;`,
 `const Original=Health;Health=Empty as any;let Restore=Original;Restore=Empty as any;Health=Restore;`,
 `const Original=Health;Health=Empty as any;if(enabled)Health=Original;`,
])test('restoration cannot recreate health without a known healthy constructor: '+body,async t=>{
 assert.ok(await missingHealth(t,body+`@Module({controllers:[Health]})class Root{}`+boot));
});
test('helper-local controller restoration retains its invocation snapshot',async t=>{
 assert.equal(await missingHealth(t,`async function start(){@Controller('health')class Local{@Get()check(){return'ok'}}const Original=Local;Local=Empty as any;Local=Original;@Module({controllers:[Local]})class Root{}const app=await NestFactory.create(Root);await app.listen(3000)}start();`),false);
});
test('different helper restorations cannot borrow a healthy constructor',async t=>{
 assert.ok(await missingHealth(t,`async function start(restore,port){@Controller('health')class Local{@Get()check(){return'ok'}}const Original=restore?Local:Empty;Local=Empty as any;Local=Original;@Module({controllers:[Local]})class Root{}const app=await NestFactory.create(Root);await app.listen(port)}start(true,3000);start(false,4000);`));
});
