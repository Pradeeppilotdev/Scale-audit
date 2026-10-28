import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

const prefix = `import express from 'express';const app=express();`;
const protection = `process.on('SIGTERM',()=>{});app.get('/health',()=> 'ok');`;
async function audit(t, body) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scale-helper-timing-guards-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  await writeFile(path.join(root,'package.json'), JSON.stringify({type:'module', dependencies:{express:'*'}}));
  await writeFile(path.join(root,'main.ts'), prefix+body);
  const report = await runAudit(root);
  assert.equal(report.complete, true, JSON.stringify(report.detectors));
  return report.findings.filter(f => ['missing-health-endpoint','missing-graceful-shutdown'].includes(f.id));
}

for (const setup of [
  `async function setup(){await load();${protection}}`,
  `async function inner(){await load();${protection}}async function setup(){await inner()}`,
]) test('awaited helper continuation cannot backfill an earlier listener: '+setup.slice(0,60), async t => {
  const findings = await audit(t, setup+`app.listen(3000);await setup();`);
  assert.ok(findings.some(f => f.id === 'missing-health-endpoint'));
  assert.ok(findings.some(f => f.id === 'missing-graceful-shutdown'));
});
for (const setup of [
  `async function setup(){await load();${protection}}`,
  `async function inner(){await load();${protection}}async function setup(){await inner()}`,
]) test('completed awaited helper protects a later listener: '+setup.slice(0,60), async t => {
  assert.equal((await audit(t, setup+`await setup();app.listen(3000);`)).length,0);
});
test('immediate setup before a helper first await remains available to an earlier listener', async t => {
  assert.equal((await audit(t, `async function setup(){${protection}await load()}app.listen(3000);await setup();`)).length,0);
});
test('detached helper completion cannot protect an outside listener', async t => {
  const findings = await audit(t, `async function setup(){await load();${protection}}setup();app.listen(3000);`);
  assert.equal(findings.length,2);
});
for (const guard of [
  `true&&process.on('SIGTERM',()=>{});`,
  `false||process.on('SIGTERM',()=>{});`,
  `null??process.on('SIGTERM',()=>{});`,
  `if(true){process.on('SIGTERM',()=>{})}`,
  `if(false){}else{process.on('SIGTERM',()=>{})}`,
  `true?process.on('SIGTERM',()=>{}):undefined;`,
]) test('known executed guard retains reached-continuation protection: '+guard, async t => {
  assert.equal((await audit(t, `await load();${guard}app.get('/health',()=> 'ok');app.listen(3000);`)).length,0);
});
for (const guard of [
  `false&&process.on('SIGTERM',()=>{});`,
  `true||process.on('SIGTERM',()=>{});`,
  `1??process.on('SIGTERM',()=>{});`,
  `if(false){process.on('SIGTERM',()=>{})}`,
  `declare const enabled:boolean;enabled&&process.on('SIGTERM',()=>{});`,
  `declare const enabled:boolean;if(enabled){process.on('SIGTERM',()=>{})}`,
]) test('skipped or unknown guard cannot establish protection: '+guard, async t => {
  assert.ok((await audit(t, `await load();${guard}app.get('/health',()=> 'ok');app.listen(3000);`)).some(f => f.id === 'missing-graceful-shutdown'));
});

test('an awaited outer helper cannot backfill its own earlier listener', async t => {
  const findings = await audit(t, `async function setup(){await load();${protection}}async function boot(){app.listen(3000);await setup()}await boot();`);
  assert.equal(findings.length,2);
});
test('an awaited outer helper retains setup completed before its listener', async t => {
  assert.equal((await audit(t, `async function setup(){await load();${protection}}async function boot(){await setup();app.listen(3000)}await boot();`)).length,0);
});
test('completed helper route alternatives retain their allocating invocation', async t => {
  const findings = await audit(t, `async function setup(target,route){await load();target.get(route,()=> 'ok')}async function boot(route,port){const server=express();await setup(server,route);server.listen(port)}await boot('/health',3000);await boot('/users',4000);`);
  assert.ok(findings.some(f => f.id === 'missing-health-endpoint'));
});

test('many awaited helper invocations deduplicate binding alternatives without quadratic work', async t => {
  const body = `async function registerBatch(event){await load();${Array.from({length:20},()=>`register(event);`).join('')}}`
    + Array.from({length:120},(_,index)=>`await registerBatch('event-${index}');`).join('');
  assert.equal((await audit(t,body)).length,0);
});
