import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runAudit } from '../dist/runner.js';

async function audit(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scale-reliability-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), '{"private":true}');
  for (const [rel, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), source);
  }
  const report = await runAudit(root);
  assert.equal(report.complete, true, JSON.stringify(report.detectors));
  return report.findings.filter(f => f.id === 'missing-rejection-handler');
}
const work = `async function task(){throw Error('x')} task();`;

test('startup helper callback parameters retain actual handler identity', async t => {
  const findings = await audit(t, {
    'main.ts': `${work} function install(handler){process.on('unhandledRejection',handler)} install(()=>{});`,
  });
  assert.equal(findings.length, 0);
});

test('noncallable startup helper argument cannot establish rejection protection', async t => {
  const findings = await audit(t, {
    'main.ts': `${work} function install(handler){process.on('unhandledRejection',handler)} install(null);`,
  });
  assert.equal(findings.length, 1);
});

test('shared setup helper does not transfer callback bindings between independent entries', async t => {
  const findings = await audit(t, {
    'setup.ts': `export function install(handler){process.on('unhandledRejection',handler)}`,
    'protected.ts': `import {install} from './setup';${work}install(()=>{});`,
    'unprotected.ts': `import {install} from './setup';${work}install(null);`,
  });
  assert.deepEqual(findings.map(f => f.file), ['unprotected.ts']);
});

test('shared workload warns if one real CommonJS entry is unprotected', async t => {
  const findings = await audit(t, {
    'protected.cjs': `process.on('unhandledRejection',()=>{});function start(){require('./work.cjs')}start();`,
    'unprotected.cjs': `function start(){require('./work.cjs')}start();`,
    'work.cjs': work,
  });
  assert.deepEqual(findings.map(f => f.file), ['work.cjs']);
});
