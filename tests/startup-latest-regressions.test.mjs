import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {runAudit} from '../dist/runner.js';

const head = `import express from 'express';const app=express();`;
const health = `app.get('/health',()=> 'ok');`;
const signal = `process.on('SIGTERM',()=>{});`;
async function audit(t, source, files = {}) {
  const root = await mkdtemp('/tmp/scale-startup-latest-');
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(root + '/package.json', JSON.stringify({type: 'module', dependencies: {express: '*'}}));
  await writeFile(root + '/main.ts', head + source);
  for (const [rel, content] of Object.entries(files)) await writeFile(root + '/' + rel, content);
  const report = await runAudit(root);
  assert.equal(report.complete, true, JSON.stringify(report.detectors));
  return report.findings;
}
const has = (findings, id) => findings.some(f => f.id === id);

for (const protection of [signal, health]) test(`optional arguments inside startup helper remain conditional: ${protection}`, async t => {
  const expression = protection.slice(0, -1);
  const findings = await audit(t, `declare const maybe:any;function start(){maybe?.(${expression});app.listen(3000)}start();`);
  assert.ok(has(findings, protection === signal ? 'missing-graceful-shutdown' : 'missing-health-endpoint'));
});
for (const protection of [signal, health]) test(`nested optional call respects every nullish guard: ${protection}`, async t => {
  const expression = protection.slice(0, -1);
  const findings = await audit(t, `const target={install:undefined};target?.install?.(${expression});app.listen(3000);`);
  assert.ok(has(findings, protection === signal ? 'missing-graceful-shutdown' : 'missing-health-endpoint'));
});
test('unconditional argument setup in startup helper still establishes protection', async t => {
  const findings = await audit(t, `function accept(value){}function start(){accept(${signal.slice(0, -1)});${health}app.listen(3000)}start();`);
  assert.ok(!has(findings, 'missing-graceful-shutdown'));
  assert.ok(!has(findings, 'missing-health-endpoint'));
});
for (const awaited of [`new Promise(()=>{})`, `load()`]) test(`detached finally after await ${awaited} does not protect outside listener`, async t => {
  const findings = await audit(t, `async function setup(){try{await ${awaited}}finally{${signal}${health}}}setup();app.listen(3000);`);
  assert.ok(has(findings, 'missing-graceful-shutdown'));
  assert.ok(has(findings, 'missing-health-endpoint'));
});
test('detached rejected await and catch do not make subsequent finally synchronous', async t => {
  const findings = await audit(t, `async function setup(){try{await Promise.reject(Error('x'))}catch{}finally{${signal}${health}}}setup();app.listen(3000);`);
  assert.ok(has(findings, 'missing-graceful-shutdown'));
  assert.ok(has(findings, 'missing-health-endpoint'));
});
for (const abrupt of [`return`, `throw Error('expected')`]) test(`synchronous ${abrupt} still executes finally protection`, async t => {
  const findings = await audit(t, `function setup(){try{${abrupt}}finally{${signal}${health}}}try{setup()}catch{}app.listen(3000);`);
  assert.ok(!has(findings, 'missing-graceful-shutdown'));
  assert.ok(!has(findings, 'missing-health-endpoint'));
});
test('awaited successful setup executes finally before listener', async t => {
  const findings = await audit(t, `async function setup(){try{await load()}finally{${signal}${health}}}await setup();app.listen(3000);`);
  assert.ok(!has(findings, 'missing-graceful-shutdown'));
  assert.ok(!has(findings, 'missing-health-endpoint'));
});
for (const dependency of [`import './setup';`, `export * from './setup';`]) test(`static dependency is hoisted across pending top-level await: ${dependency}`, async t => {
  const findings = await audit(t, `app.listen(3000);await new Promise(()=>{});${dependency}`, {'setup.ts': signal});
  assert.ok(!has(findings, 'missing-graceful-shutdown'));
});
test('type-only dependency after pending await does not install protection', async t => {
  const findings = await audit(t, `app.listen(3000);await new Promise(()=>{});import type {Config} from './setup';`, {'setup.ts': `export interface Config{}${signal}`});
  assert.ok(has(findings, 'missing-graceful-shutdown'));
});
for (const target of [`null`, `undefined`]) test(`optional method-call chain skips outer call arguments for ${target}`, async t => {
  const findings = await audit(t, `const target=${target};target?.method().install(${signal.slice(0, -1)});app.listen(3000);`);
  assert.ok(has(findings, 'missing-graceful-shutdown'));
});
test('unreachable catch suspension does not delay synchronous finally setup', async t => {
  const findings = await audit(t, `async function setup(){try{}catch{await new Promise(()=>{})}finally{${signal}${health}}}setup();app.listen(3000);`);
  assert.ok(!has(findings, 'missing-graceful-shutdown'));
  assert.ok(!has(findings, 'missing-health-endpoint'));
});
test('return does not enter a suspending catch before synchronous finally', async t => {
  const findings = await audit(t, `async function setup(){try{return}catch{await new Promise(()=>{})}finally{${signal}${health}}}setup();app.listen(3000);`);
  assert.ok(!has(findings, 'missing-graceful-shutdown'));
  assert.ok(!has(findings, 'missing-health-endpoint'));
});
