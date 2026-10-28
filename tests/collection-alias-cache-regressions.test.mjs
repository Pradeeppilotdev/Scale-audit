import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';
import {Workspace} from '../dist/workspace.js';
import {ServiceContexts, serviceContexts} from '../dist/serviceContext.js';

async function fixture(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scale-collection-alias-cache-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({dependencies: {express: '*'}}));
  for (const [name, source] of Object.entries(files)) await writeFile(path.join(root, name), source);
  return root;
}
function aliases(count) {
  return 'const a0={cache:new Map()};' + Array.from({length: count}, (_, i) => `const a${i + 1}=a${i};`).join('');
}
const lookups = count => Array.from({length: count}, () => 'a60.cache.get(key);').join('');
const entry = `import './shared';import express from 'express';const app=express();app.listen(3000);`;

for (const entries of [1, 10]) test(`${entries} services reuse 60-deep collection aliases across 2000 lookups`, async t => {
  const files = {'shared.ts': aliases(60) + 'declare const key:any;' + lookups(2000)};
  for (let i = 0; i < entries; i++) files[`entry${i}.ts`] = entry;
  const report = await runAudit(await fixture(t, files));
  assert.equal(report.complete, true, JSON.stringify(report.detectors));
  assert.equal(report.findings.filter(f => ['missing-health-endpoint', 'missing-graceful-shutdown'].includes(f.id)).length, 2 * entries);
});

for (const [label, mutation] of [
  ['direct mutation', 'a30.cache=server;'],
  ['binding reassignment', 'a30=server;'],
  ['escaped alias', 'mutate(a30);'],
  ['escaped wrapper', 'mutate({alias:a30});'],
]) test(`cached alias resolution retains ${label}`, async t => {
  const root = await fixture(t, {'main.ts': aliases(60) + `declare const server:any;declare const key:any;${mutation}` + lookups(2000)});
  const ws = await Workspace.load(root);
  const owners = new ServiceContexts(root, ws).entryContexts();
  assert.equal([...owners[0].protectiveCalls].filter(call => call.expression.getText() === 'a60.cache.get').length, 2000);
});

test('a warmed short suffix does not bypass argument depth exhaustion', async t => {
  const suffix = '('.repeat(60) + "'/health'" + ')'.repeat(60);
  const longer = '('.repeat(10) + 'path' + ')'.repeat(10);
  const root = await fixture(t, {'main.ts': `const path=${suffix};const deeper=${longer};declare const app:any;app.get(path,()=>{});app.get(deeper,()=>{});`});
  const ws = await Workspace.load(root);
  assert.throws(() => new ServiceContexts(root, ws).entryContexts(), /Startup argument depth limit exceeded/);
  assert.throws(() => new ServiceContexts(root, ws).entryContexts(), /Startup argument depth limit exceeded/);
});

for (const reuse of ['same context', 'fresh context']) test(`failed collection scans remain strict with ${reuse} and the same Workspace`, async t => {
  // Startup skips this helper body, while the source-wide escape index must
  // traverse it. The depth failure therefore occurs while collecting facts.
  const wrapper = '{child:'.repeat(70) + 'registry' + '}'.repeat(70);
  const root = await fixture(t, {'main.ts': `const registry={cache:new Map()};function unused(){const wrapped=${wrapper};mutate(wrapped);}declare const key:any;registry.cache.get(key);`});
  const ws = await Workspace.load(root);
  const first = serviceContexts(root, ws);
  assert.throws(() => first.entryContexts(), /Startup argument depth limit exceeded/);
  const second = reuse === 'same context' ? first : new ServiceContexts(root, ws);
  assert.throws(() => second.entryContexts(), /Startup argument depth limit exceeded/);
});

test('cyclic immutable aliases remain uncertain rather than collection proof', async t => {
  const root = await fixture(t, {'main.ts': 'const left=right;const right=left;declare const key:any;left.cache.get(key);'});
  const ws = await Workspace.load(root);
  const owner = new ServiceContexts(root, ws).entryContexts()[0];
  assert.equal([...owner.protectiveCalls].filter(call => call.expression.getText() === 'left.cache.get').length, 1);
});
