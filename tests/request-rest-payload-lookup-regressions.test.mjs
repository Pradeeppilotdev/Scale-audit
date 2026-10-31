import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';

async function high(t, body) {
  const root = await mkdtemp('/tmp/scale-rest-payload-lookup-');
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(`${root}/main.ts`, `import http from 'node:http';import fs from 'node:fs';${body}`);
  return (await detectSyncIo(root)).filter(finding => finding.id === 'sync-io' && finding.severity === 'high');
}

for (const index of ['0', '"0"']) test('rest indexing preserves a supplied array: ' + index, async t => {
  assert.equal((await high(t, `function read(...values){values[${index}].forEach(()=>fs.readFileSync('live'))}http.createServer(()=>read([1]));`)).length, 1);
});

test('a selected rest array retains helper forwarding', async t => {
  assert.equal((await high(t, `function visit(items){items.forEach(()=>fs.readFileSync('live'))}function read(...values){visit(values[0])}http.createServer(()=>read([1]));`)).length, 1);
});

test('a selected rest promise retains native callback identity', async t => {
  assert.equal((await high(t, `function read(...values){values[0].then(()=>fs.readFileSync('live'))}http.createServer(()=>read(Promise.resolve(1)));`)).length, 1);
});

test('out-of-range rest indexing does not invent a callback receiver', async t => {
  assert.equal((await high(t, `function read(...values){values[3]?.forEach(()=>fs.readFileSync('dead'))}http.createServer(()=>read([1]));`)).length, 0);
});

test('scalar rest elements do not become native arrays', async t => {
  assert.equal((await high(t, `function read(...values){values[0].forEach(()=>fs.readFileSync('dead'))}http.createServer(()=>read(1));`)).length, 0);
});

test('unknown spread positions retain uncertain payload identity', async t => {
  assert.equal((await high(t, `function read(...values){values[0].forEach(()=>fs.readFileSync('possible'))}http.createServer(()=>read(...external));`)).length, 0);
});

test('reassigned rest positions do not retain stale array payloads', async t => {
  assert.equal((await high(t, `function read(...values){values[0]=[];values[0].forEach(()=>fs.readFileSync('dead'))}http.createServer(()=>read([1]));`)).length, 0);
});
