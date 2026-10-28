import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

async function audit(t, body, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scale-nested-property-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({dependencies: {express: '*'}}));
  for (const [name, source] of Object.entries({'main.ts': `import express from 'express';${body}`, ...files})) {
    await writeFile(path.join(root, name), source);
  }
  const report = await runAudit(root);
  assert.equal(report.complete, true, JSON.stringify(report.detectors));
  return report.findings;
}
const hasHealthWarning = findings => findings.some(f => f.id === 'missing-health-endpoint');

for (const replacement of [
  `if(enabled)holder.inner={app:express()};`,
  `function replace(target){target.inner={app:express()}}replace(holder);`,
  `Object.assign(holder,{inner:{app:express()}});`,
]) test('uncertain intermediate replacement cannot recover stale health: '+replacement, async t => {
  const findings = await audit(t, `const holder={inner:{app:express()}};holder.inner.app.get('/health',()=> 'ok');${replacement}holder.inner.app.listen(3000);`);
  assert.ok(hasHealthWarning(findings));
});

test('unknown intermediate replacement preserves discovery for a nonconventional leaf name', async t => {
  const findings = await audit(t, `const holder={inner:{service:express()}};holder.inner.service.get('/health',()=> 'ok');if(enabled)holder.inner={service:express()};holder.inner.service.listen(3000);`);
  assert.ok(hasHealthWarning(findings));
  assert.ok(findings.some(f => f.id === 'missing-graceful-shutdown'));
});

test('immutable nested properties retain valid health', async t => {
  assert.equal(hasHealthWarning(await audit(t, `const holder={inner:{app:express()}};holder.inner.app.get('/health',()=> 'ok');holder.inner.app.listen(3000);`)), false);
});

test('direct replacement retains health established on the current nested allocation', async t => {
  assert.equal(hasHealthWarning(await audit(t, `const holder={inner:{app:express()}};holder.inner={app:express()};holder.inner.app.get('/health',()=> 'ok');holder.inner.app.listen(3000);`)), false);
});

test('captured intermediate alias retains its allocation before later conditional writes', async t => {
  assert.equal(hasHealthWarning(await audit(t, `const holder={inner:{app:express()}};const old=holder.inner;old.app.get('/health',()=> 'ok');if(enabled)holder.inner={app:express()};old.app.listen(3000);`)), false);
});

test('unrelated nested writes do not invalidate the listening object', async t => {
  assert.equal(hasHealthWarning(await audit(t, `const holder={inner:{app:express()}};const other={inner:{app:express()}};holder.inner.app.get('/health',()=> 'ok');if(enabled)other.inner={app:express()};holder.inner.app.listen(3000);`)), false);
});

test('namespace-exported variable properties retain their actual declaration identity', async t => {
  assert.equal(hasHealthWarning(await audit(t, `import * as servers from './servers';servers.app.get('/health',()=> 'ok');servers.app.listen(3000);`, {'servers.ts': `import express from 'express';export const app=express();`})), false);
});

test('known replacement with a collection remains excluded from server discovery', async t => {
  const findings = await audit(t, `const holder={inner:{service:express()}};holder.inner={service:new Map()};holder.inner.service.listen(3000);`);
  assert.equal(findings.some(f => f.id === 'missing-graceful-shutdown'), false);
  assert.equal(hasHealthWarning(findings), false);
});
