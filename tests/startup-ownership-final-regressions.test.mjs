import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runAudit} from '../dist/runner.js';

async function audit(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scale-ownership-final-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({type: 'module', dependencies: {express: '*'}}));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), {recursive: true});
    await writeFile(path.join(root, rel), content);
  }
  const report = await runAudit(root);
  assert.equal(report.complete, true, JSON.stringify(report.detectors));
  return report;
}
const server = `import express from 'express';const app=express();`;
const task = `async function work(){throw Error('x')}`;
const signals = `process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{});`;
const has = (report, id, file) => report.findings.some(f => f.id === id && (!file || f.file === file));

test('awaited literal dynamic import installs startup protection for its importer', async t => {
  const report = await audit(t, {
    'main.ts': `${server}await import('./setup');app.listen(3000);${task}work();`,
    'setup.ts': signals,
  });
  assert.ok(!has(report, 'missing-graceful-shutdown'));
  assert.ok(!has(report, 'missing-rejection-handler'));
  assert.ok(has(report, 'floating-promise'));
});

test('unawaited dynamic import does not prove protection was installed before startup work', async t => {
  const report = await audit(t, {
    'main.ts': `${server}import('./setup');app.listen(3000);${task}work();`,
    'setup.ts': signals,
  });
  assert.ok(has(report, 'missing-graceful-shutdown'));
  assert.ok(has(report, 'missing-rejection-handler'));
});

test('awaited setup import is scoped to its real entry rather than every service', async t => {
  const report = await audit(t, {
    'protected.ts': `${server}await import('./setup');app.listen(3000);${task}work();`,
    'unprotected.ts': `${server}app.listen(4000);${task}work();`,
    'setup.ts': signals,
  });
  assert.ok(!has(report, 'missing-graceful-shutdown', 'protected.ts'));
  assert.ok(!has(report, 'missing-rejection-handler', 'protected.ts'));
  assert.ok(has(report, 'missing-graceful-shutdown', 'unprotected.ts'));
  assert.ok(has(report, 'missing-rejection-handler', 'unprotected.ts'));
});

test('rejection handler in the same reached startup block protects the guarded work', async t => {
  const report = await audit(t, {'main.ts': `${task}if(process.env.ENABLED){work();process.on('unhandledRejection',()=>{});}`});
  assert.ok(has(report, 'floating-promise'));
  assert.ok(!has(report, 'missing-rejection-handler'));
});

test('rejection handler in an alternate branch cannot protect guarded work', async t => {
  const report = await audit(t, {'main.ts': `${task}if(process.env.ENABLED){work();}else{process.on('unhandledRejection',()=>{});}`});
  assert.ok(has(report, 'missing-rejection-handler'));
});

test('narrower conditional rejection handler does not protect all work', async t => {
  const report = await audit(t, {'main.ts': `${task}if(process.env.ENABLED){work();if(process.env.PROTECT){process.on('unhandledRejection',()=>{});}}`});
  assert.ok(has(report, 'missing-rejection-handler'));
});

test('one protected guarded call cannot hide unprotected work in the same source', async t => {
  const report = await audit(t, {'main.ts': `${task}if(process.env.ENABLED){work();process.on('unhandledRejection',()=>{});}else{work();}`});
  assert.ok(has(report, 'missing-rejection-handler'));
});

test('shared modules containing actual calls avoid repeated merging under the unchanged budget', async t => {
  const files = {'shared.ts': Array.from({length: 1000}, (_, i) => `register(${i});`).join('\n')};
  for (let i = 0; i < 100; i++) files[`entry${i}.ts`] = `import './shared';export const id=${i};`;
  const report = await audit(t, files);
  assert.equal(report.coverage.analyzed, 101);
  assert.equal(report.findings.length, 0);
});

test('conditional valid helper invocation cannot repair a definite invalid invocation', async t => {
  const report = await audit(t, {'main.ts': `${task}function install(callback){process.on('unhandledRejection',callback)}install(null);if(process.env.PROTECT){install(()=>{});}work();`});
  assert.ok(has(report, 'missing-rejection-handler'));
});

test('conditional invalid helper invocation does not erase a definite valid listener', async t => {
  const report = await audit(t, {'main.ts': `${task}function install(callback){process.on('unhandledRejection',callback)}install(()=>{});if(process.env.PROTECT){install(null);}work();`});
  assert.ok(!has(report, 'missing-rejection-handler'));
});

test('awaited import inside detached setup cannot protect an outside listener', async t => {
  const report = await audit(t, {
    'main.ts': `${server}async function install(){await import('./setup')}install();app.listen(3000);`,
    'setup.ts': signals,
  });
  assert.ok(has(report, 'missing-graceful-shutdown'));
});

test('listener after awaited import inside async bootstrap has its imported protection', async t => {
  const report = await audit(t, {
    'main.ts': `${server}async function start(){await import('./setup');app.listen(3000)}start();`,
    'setup.ts': signals,
  });
  assert.ok(!has(report, 'missing-graceful-shutdown'));
});

test('event and callback from separate invocations cannot combine into false protection', async t => {
  const report = await audit(t, {
    'main.ts': `${server}function install(event,handler){process.on(event,handler)}install('wrongEvent',()=>{});install('SIGTERM',null);app.listen(3000);`,
  });
  assert.ok(has(report, 'missing-graceful-shutdown'));
});

test('awaited setup import after listener cannot retroactively establish startup protection', async t => {
  const report = await audit(t, {
    'main.ts': `${server}async function start(){app.listen(3000);await import('./setup')}start();`,
    'setup.ts': signals,
  });
  assert.ok(has(report, 'missing-graceful-shutdown'));
});
