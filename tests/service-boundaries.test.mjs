import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {runAudit} from '../dist/runner.js';

async function audit(t, files, deps = {express:'*'}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scale-services-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  await writeFile(path.join(root,'package.json'), JSON.stringify({private:true,dependencies:deps}));
  for (const [rel,text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root,rel)), {recursive:true});
    await writeFile(path.join(root,rel),text);
  }
  const report = await runAudit(root);
  assert.equal(report.complete,true);
  return report.findings;
}
const server = `import express from 'express'; const app=express(); app.listen(3000);`;
const floating = `async function task(){throw Error('x')} task();`;
const has = (findings,id,file) => findings.some(f=>f.id===id && (!file || f.file===file));

test('unused functions and unrelated modules cannot supply service protection', async t => {
  const f = await audit(t, {'server.ts':server+floating,'unused.ts':`function unused(){process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{});const cache=new Map();cache.get('/health');}`});
  for (const id of ['missing-health-endpoint','missing-graceful-shutdown','missing-rejection-handler']) assert.ok(has(f,id));
});
test('called startup helpers install protection across imports',async t=>{
  const f=await audit(t,{'server.ts':`import {install} from './setup'; ${server} install(); app.get('/health',()=> 'ok'); ${floating}`,'setup.ts':`export function install(){process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{});}`});
  for(const id of ['missing-health-endpoint','missing-graceful-shutdown','missing-rejection-handler']) assert.ok(!has(f,id));
});
test('unused imported setup function does not install protection',async t=>{
  const f=await audit(t,{'server.ts':`import {install} from './setup'; ${server} ${floating}`,'setup.ts':`export function install(){process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{});}`});
  assert.ok(has(f,'missing-graceful-shutdown'));assert.ok(has(f,'missing-rejection-handler'));
});
test('services in the same package cannot borrow each others protection',async t=>{
  const f=await audit(t,{'a.ts':server+`app.get('/health',()=> 'ok');process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{});`,'b.ts':server+floating});
  assert.ok(has(f,'missing-health-endpoint','b.ts'));assert.ok(has(f,'missing-graceful-shutdown','b.ts'));assert.ok(has(f,'missing-rejection-handler','b.ts'));
  assert.ok(!has(f,'missing-health-endpoint','a.ts'));
});
test('workspace service uses its own manifest',async t=>{
  const f=await audit(t,{'packages/api/package.json':JSON.stringify({dependencies:{express:'*'}}),'packages/api/server.ts':server},{});
  assert.ok(has(f,'missing-health-endpoint'));
});
for(const event of ['unhandledRejectionError','uncaughtException']) test(`${event} does not establish rejection handling`,async t=>{
  const f=await audit(t,{'app.ts':floating+`process.on('${event}',()=>{});`});assert.ok(has(f,'missing-rejection-handler'));
});
for(const callback of ['null','123','{}','undefined']) test(`invalid process listener ${callback} does not suppress warning`,async t=>{
  const f=await audit(t,{'app.ts':floating+`process.on('unhandledRejection',${callback});`});assert.ok(has(f,'missing-rejection-handler'));
});
test('shadowed process does not establish protection',async t=>{
  const f=await audit(t,{'app.ts':`const process={on(){}}; ${server} ${floating} process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{});`});assert.ok(has(f,'missing-rejection-handler'));assert.ok(has(f,'missing-graceful-shutdown'));
});
test('native process import alias and named callback are recognized',async t=>{
  const f=await audit(t,{'app.ts':`import proc from 'node:process';function onError(){};${floating}proc.on('unhandledRejection',onError);`});assert.ok(!has(f,'missing-rejection-handler'));
});
test('conditional startup registration does not establish guaranteed protection',async t=>{
  const f=await audit(t,{'app.ts':floating+`if(enabled){process.on('unhandledRejection',()=>{});}`});assert.ok(has(f,'missing-rejection-handler'));
});
test('normal Nest controller paths are combined',async t=>{
  const f=await audit(t,{'app.ts':`import {Controller,Get,Module} from '@nestjs/common';import {NestFactory} from '@nestjs/core';@Controller('health') class Health{@Get() check(){return 'ok'}} @Module({controllers:[Health]}) class AppModule{} async function main(){const app=await NestFactory.create(AppModule);app.enableShutdownHooks();await app.listen(3000)}main();`},{'@nestjs/core':'*'});
  assert.ok(!has(f,'missing-health-endpoint'));assert.ok(!has(f,'missing-graceful-shutdown'));
});
test('Nest prefix must compose to an actual health path',async t=>{
  const f=await audit(t,{'app.ts':`import {Controller,Get} from '@nestjs/common';@Controller('users') class Health{@Get('health') check(){return 'ok'}}${server}`});assert.ok(has(f,'missing-health-endpoint'));
});
test('retry comments and strings are not retry evidence',async t=>{
  const f=await audit(t,{'app.ts':`// withRetry backoff retry()
const message='retry()';export async function GET(){return fetch('https://example.com')}`});assert.ok(has(f,'no-retry-strategy'));
});
for(const args of [['--formatt','json'],['--out'],['--out','--fix'],['second-target'],['--diff','--fix'],['--fix','--diff']]) test(`CLI rejects ${args.join(' ')}`,()=>{
  const result=spawnSync(process.execPath,['dist/cli.js','tests/fixtures/badapp',...args],{encoding:'utf8'});
  assert.equal(result.status,1);assert.equal(result.stdout,'');assert.match(result.stderr,/unknown option|requires a file|Exactly one|cannot be combined/);
});

test('imported but unmounted router cannot hide missing health endpoint',async t=>{
  const f=await audit(t,{'app.ts':`import router from './router';${server}`,'router.ts':`import express from 'express';const router=express.Router();router.get('/health',()=> 'ok');export default router;`});assert.ok(has(f,'missing-health-endpoint'));
});
test('explicitly mounted root router provides health endpoint',async t=>{
  const f=await audit(t,{'app.ts':`import router from './router';${server}app.use(router);`,'router.ts':`import express from 'express';const router=express.Router();router.get('/health',()=> 'ok');export default router;`});assert.ok(!has(f,'missing-health-endpoint'));
});
test('unregistered Nest controller cannot hide missing health endpoint',async t=>{
  const f=await audit(t,{'app.ts':`import {Controller,Get,Module} from '@nestjs/common';import {NestFactory} from '@nestjs/core';@Controller('health') class Health{@Get() check(){return 'ok'}}@Module({})class AppModule{} async function main(){const app=await NestFactory.create(AppModule);await app.listen(3000)}main();`},{'@nestjs/core':'*'});assert.ok(has(f,'missing-health-endpoint'));
});
test('registration after an unconditional return cannot establish protection',async t=>{
  const f=await audit(t,{'app.ts':`${floating}function setup(){return;process.on('unhandledRejection',()=>{});}setup();`});assert.ok(has(f,'missing-rejection-handler'));
});
test('empty nested package does not inherit root framework dependencies',async t=>{
  const f=await audit(t,{'packages/tool/package.json':'{}','packages/tool/server.ts':`const server=customServer();server.listen(3000);`});assert.ok(!has(f,'missing-health-endpoint'));
});

test('deep startup import chains complete without repeatedly scanning every suffix',async t=>{
  const files={'server.ts':`import './chain0';${server}`};
  for(let i=0;i<180;i++)files[`chain${i}.ts`]=i===179?`process.on('SIGTERM',()=>{});`:`import './chain${i+1}';`;
  const f=await audit(t,files);assert.ok(!has(f,'missing-graceful-shutdown'));
});
test('listener in a called imported bootstrap is audited',async t=>{
  const f=await audit(t,{'index.ts':`import {start} from './server';start();`,'server.ts':`import express from 'express';export function start(){const app=express();app.listen(3000)}`});assert.ok(has(f,'missing-health-endpoint','server.ts'));
});
test('dependency presence is advisory rather than an established runtime penalty',async t=>{
  const f=await audit(t,{'app.ts':'export const value=1;'},{lodash:'*'});
  const finding=f.find(f=>f.id==='heavy-dependency');assert.equal(finding?.severity,'info');assert.equal(finding?.confidence,'low');
});
test('report identifies analyzer version and distinguishes execution from semantic coverage',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'scale-provenance-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'app.ts'),'export const value=1;');
  const r=await runAudit(root);
  assert.equal(r.schemaVersion,1);assert.equal(r.analyzer.name,'@pradeeppilot/scale-audit');assert.match(r.analyzer.version,/^\d+\.\d+\.\d+/);
  assert.match(r.analysisScope.limitations.join(' '),/unsupported or unresolved/);assert.equal(r.complete,true);
});

test('CommonJS shared source uses its actual startup owner for rejection protection',async t=>{
  const f=await audit(t,{'main.cjs':`require('./work.cjs');process.on('unhandledRejection',()=>{});`,'work.cjs':floating});assert.ok(!has(f,'missing-rejection-handler'));
});
test('static class initialization registers listeners but instance initializers do not',async t=>{
  const protectedFindings=await audit(t,{'main.ts':`${floating}class Setup{static {process.on('unhandledRejection',()=>{});}}`});assert.ok(!has(protectedFindings,'missing-rejection-handler'));
  const unprotectedFindings=await audit(t,{'main.ts':`${floating}class Setup{handler=process.on('unhandledRejection',()=>{});}`});assert.ok(has(unprotectedFindings,'missing-rejection-handler'));
});
