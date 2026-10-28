import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

async function audit(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scale-conditional-startup-rc-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({type: 'module', dependencies: {express: '*'}}));
  await writeFile(path.join(root, 'main.ts'), `import express from 'express';const app=express();${prefix};app.listen(3000);`);
  const report = await runAudit(root);
  assert.equal(report.complete, true, JSON.stringify(report.detectors));
  return report.findings;
}
const lifecycle = findings => findings.filter(f => ['missing-health-endpoint', 'missing-graceful-shutdown'].includes(f.id));
const pending = 'await new Promise(()=>{})';
const rejected = 'await Promise.reject(Error())';

for (const expression of [
  `declare const enabled:boolean;enabled&&${pending}`,
  `declare const enabled:boolean;enabled||${pending}`,
  `declare const maybe:any;maybe??${pending}`,
  `declare const enabled:boolean;enabled&&${rejected}`,
  `declare const maybe:any;maybe?.(${pending})`,
  `declare const maybe:any;maybe?.(${rejected})`,
  `declare const maybe:any;maybe?.[${pending}]()`,
  `declare const maybe:any;maybe?.property[${pending}]()`,
  `declare const maybe:any;maybe?.method()[${pending}]()`,
]) test(`conditional suspension preserves skipped startup path: ${expression}`, async t => {
  assert.equal(lifecycle(await audit(t, expression)).length, 2);
});

for (const expression of [
  `true&&${pending}`,
  `false||${pending}`,
  `null??${pending}`,
  `undefined??${pending}`,
  `(void 0)??${pending}`,
  `const present=()=>{};present?.(${pending})`,
  `const present={};present?.[${pending}]`,
]) test(`known executed pending operand still stops startup: ${expression}`, async t => {
  assert.equal(lifecycle(await audit(t, expression)).length, 0);
});

for (const expression of [
  `false&&${pending}`,
  `true||${pending}`,
  `false??${pending}`,
  `0??${pending}`,
  `const absent=null;absent?.(${pending})`,
]) test(`known skipped pending operand retains startup: ${expression}`, async t => {
  assert.equal(lifecycle(await audit(t, expression)).length, 2);
});

for (const expression of [
  `declare const enabled:boolean;enabled&&((${pending}),process.on('SIGTERM',()=>{}))`,
  `declare const maybe:any;maybe?.(${pending},process.on('SIGTERM',()=>{}))`,
  `declare const maybe:any;maybe?.property[((${pending}),process.on('SIGTERM',()=>{}))]()`,
]) test(`skipped path does not establish conditional protection: ${expression}`, async t => {
  assert.ok((await audit(t, expression)).some(f => f.id === 'missing-graceful-shutdown'));
});

for (const expression of [`undefined&&${pending}`, `(void 0)&&${pending}`, `0??${pending}`]) test(`known skipped operand preserves subsequent definite protection: ${expression}`, async t => {
  assert.equal(lifecycle(await audit(t, expression+`;process.on('SIGTERM',()=>{});app.get('/health',()=> 'ok')`)).length, 0);
});

for (const expression of [
  `declare const enabled:boolean;enabled&&${pending}`,
  `declare const maybe:any;maybe?.(${pending})`,
  `declare const maybe:any;maybe?.property[${pending}]()`,
]) test(`reaching listener establishes subsequent direct protection: ${expression}`, async t => {
  assert.equal(lifecycle(await audit(t, expression+`;app.get('/health',()=> 'ok');process.on('SIGTERM',()=>{})`)).length, 0);
});

test('reached-prefix proof does not promote guarded protection in source body', async t => {
  assert.ok((await audit(t, `declare const enabled:boolean;enabled&&((${pending}),process.on('SIGTERM',()=>{}));app.get('/health',()=> 'ok')`)).some(f => f.id === 'missing-graceful-shutdown'));
});

test('conditional await after an earlier listener cannot backfill its shutdown protection', async t => {
  const findings = await audit(t, `declare const enabled:boolean;app.listen(4000);\nenabled&&${pending};process.on('SIGTERM',()=>{})`);
  assert.equal(findings.filter(f => f.id === 'missing-graceful-shutdown').length, 1);
});

test('top-level await cannot install later protection for an earlier listener', async t => {
  const findings = await audit(t, `app.listen(4000);\nawait wait();app.get('/health',()=> 'ok');process.on('SIGTERM',()=>{})`);
  assert.equal(findings.filter(f => f.id === 'missing-graceful-shutdown').length, 1);
  assert.equal(findings.filter(f => f.id === 'missing-health-endpoint').length, 1);
});

test('top-level successful continuation retains its direct protection', async t => {
  assert.equal(lifecycle(await audit(t, `await wait();app.get('/health',()=> 'ok');process.on('SIGTERM',()=>{})`)).length, 0);
});

async function auditImport(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scale-conditional-import-rc-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({type: 'module', dependencies: {express: '*'}}));
  await writeFile(path.join(root, 'main.ts'), `import express from 'express';const app=express();${prefix}`);
  await writeFile(path.join(root, 'setup.ts'), `process.on('SIGTERM',()=>{});`);
  const report = await runAudit(root);
  assert.equal(report.complete, true, JSON.stringify(report.detectors));
  return report.findings;
}

test('awaited dynamic import cannot backfill protection for earlier listener', async t => {
  const findings = await auditImport(t, `app.listen(4000);\nawait import('./setup');app.listen(3000);`);
  assert.equal(findings.filter(f => f.id === 'missing-graceful-shutdown').length, 1);
});

test('listener after awaited dynamic import retains imported protection', async t => {
  const findings = await auditImport(t, `await import('./setup');app.listen(3000);`);
  assert.ok(!findings.some(f => f.id === 'missing-graceful-shutdown'));
});

test('unconditional aborting helper cannot revive later module protection', async t => {
  const findings = await audit(t, `function validate(){throw Error()}validate();app.get('/health',()=> 'ok');process.on('SIGTERM',()=>{})`);
  assert.equal(lifecycle(findings).length, 2);
});

test('guarded aborting helper retains skipped path with subsequent direct protection', async t => {
  const findings = await audit(t, `function validate(){throw Error()}declare const enabled:boolean;enabled&&validate();app.get('/health',()=> 'ok');process.on('SIGTERM',()=>{})`);
  assert.equal(lifecycle(findings).length, 0);
});
