import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {runAudit} from '../dist/runner.js';

async function audit(t, files) {
  const root = await mkdtemp('/tmp/scale-startup-reliability-latest-');
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(`${root}/package.json`, JSON.stringify({type: 'module'}));
  for (const [name, source] of Object.entries(files)) await writeFile(`${root}/${name}`, source);
  const report = await runAudit(root);
  assert.equal(report.complete, true, JSON.stringify(report.detectors));
  return report.findings;
}
const work = `async function work(){throw Error('failed')}`;
const missing = findings => findings.some(f => f.id === 'missing-rejection-handler');

test('optional registration argument cannot protect work in the same helper', async t => {
  const findings = await audit(t, {'main.ts': `${work};declare const maybe:any;function start(){maybe?.(process.on('unhandledRejection',()=>{}));work()}start();`});
  assert.ok(missing(findings));
});

test('nested optional call guard cannot establish rejection protection', async t => {
  const findings = await audit(t, {'main.ts': `${work};const target={install:undefined};target?.install?.(process.on('unhandledRejection',()=>{}));work();`});
  assert.ok(missing(findings));
});

test('never-reached finally does not protect outside asynchronous work', async t => {
  const findings = await audit(t, {'main.ts': `${work};async function setup(){try{await new Promise(()=>{})}finally{process.on('unhandledRejection',()=>{})}}setup();work();`});
  assert.ok(missing(findings));
});

test('static import following suspended module body still supplies rejection protection', async t => {
  const findings = await audit(t, {
    'main.ts': `${work};work();await new Promise(()=>{});import './protection.js';`,
    'protection.ts': `process.on('unhandledRejection',()=>{});`,
  });
  assert.ok(findings.some(f => f.id === 'floating-promise'));
  assert.ok(!missing(findings));
});
