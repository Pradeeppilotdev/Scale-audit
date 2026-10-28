import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

async function audit(t, source) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scale-release-reliability-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(root, 'main.ts'), `async function work(){throw Error('failed')} ${source}`);
  const report = await runAudit(root);
  assert.equal(report.complete, true, JSON.stringify(report.detectors));
  return report.findings.some(f => f.id === 'missing-rejection-handler');
}

test('returned pending await cannot establish finally rejection protection', async t => {
  assert.ok(await audit(t, `async function setup(){try{return await new Promise(()=>{})}finally{process.on('unhandledRejection',()=>{})}}setup();work();`));
});
test('optional computed callee cannot establish rejection protection', async t => {
  assert.ok(await audit(t, `declare const maybe:any;maybe?.property[process.on('unhandledRejection',()=>{})]();work();`));
});
test('finally return cancels throw before subsequent rejection protection', async t => {
  assert.equal(await audit(t, `function validate(){try{throw Error()}finally{return}}validate();process.on('unhandledRejection',()=>{});work();`), false);
});
test('finally throw still invalidates subsequent rejection protection', async t => {
  assert.ok(await audit(t, `function validate(){try{return}finally{throw Error()}}validate();process.on('unhandledRejection',()=>{});work();`));
});
