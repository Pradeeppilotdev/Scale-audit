import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

async function audit(t, source) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scale-server-discovery-release-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({dependencies: {express: '*'}}));
  await writeFile(path.join(root, 'main.ts'), source);
  const report = await runAudit(root);
  assert.equal(report.complete, true, JSON.stringify(report.detectors));
  return report.findings.filter(f => ['missing-health-endpoint', 'missing-graceful-shutdown'].includes(f.id));
}

for (const declaration of ['const', 'let']) test(`${declaration} conventional receiver retains discovery through an opaque wrapper`, async t => {
  const findings = await audit(t, `import express from 'express';function buildApplication(){return express()}${declaration} app=buildApplication();app.listen(3000);`);
  assert.ok(findings.some(f => f.id === 'missing-health-endpoint'));
  assert.ok(findings.some(f => f.id === 'missing-graceful-shutdown'));
});

test('conventional receiver retains discovery through an immutable alias', async t => {
  const findings = await audit(t, `import express from 'express';function buildApplication(){return express()}const service=buildApplication();const app=service;app.listen(3000);`);
  assert.ok(findings.some(f => f.id === 'missing-health-endpoint'));
  assert.ok(findings.some(f => f.id === 'missing-graceful-shutdown'));
});

test('conventional receiver preserves existing shutdown protection for wrapper factories', async t => {
  const findings = await audit(t, `import express from 'express';function buildApplication(){return express()}const app=buildApplication();process.on('SIGTERM',()=>{});app.listen(3000);`);
  assert.ok(findings.some(f => f.id === 'missing-health-endpoint'));
  assert.ok(!findings.some(f => f.id === 'missing-graceful-shutdown'));
});

for (const collection of ['Map', 'Set', 'WeakMap', 'WeakSet']) test(`known ${collection} allocation overrides a conventional receiver hint`, async t => {
  const findings = await audit(t, `const app=new ${collection}();app.listen(3000);`);
  assert.equal(findings.length, 0);
});

test('unrelated nonconventional receiver keeps conservative discovery', async t => {
  const findings = await audit(t, `function buildApplication(){return {listen(){}}}const service=buildApplication();service.listen(3000);`);
  assert.equal(findings.length, 0);
});

test('local constructor name alone does not discover a nonconventional receiver', async t => {
  const findings = await audit(t, `class Koa{listen(){}}const service=new Koa();service.listen(3000);`);
  assert.equal(findings.length, 0);
});

test('helper receiver retains the bound conventional initializer name', async t => {
  const findings = await audit(t, `import express from 'express';function buildApplication(){return express()}const app=buildApplication();function start(target){target.listen(3000)}start(app);`);
  assert.ok(findings.some(f => f.id === 'missing-health-endpoint'));
  assert.ok(findings.some(f => f.id === 'missing-graceful-shutdown'));
});

test('helper receiver bound to a nonconventional opaque initializer stays conservative', async t => {
  const findings = await audit(t, `function buildApplication(){return {listen(){}}}const service=buildApplication();function start(target){target.listen(3000)}start(service);`);
  assert.equal(findings.length, 0);
});

test('helper receiver bound to a collection still excludes conventional initializer names', async t => {
  const findings = await audit(t, `const app=new Map();function start(target){target.listen(3000)}start(app);`);
  assert.equal(findings.length, 0);
});
