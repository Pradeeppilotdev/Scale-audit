import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {runAudit} from '../dist/runner.js';

async function high(t, files) {
  const root = await mkdtemp('/tmp/scale-release-review-integration-');
  t.after(() => rm(root, {recursive: true, force: true}));
  for (const [name, source] of Object.entries(files)) await writeFile(`${root}/${name}`, source);
  const report = await runAudit(root);
  assert.equal(report.complete, true);
  assert.equal(report.coverage.analyzed, Object.keys(files).length);
  return report.findings.filter(finding => finding.id === 'sync-io' && finding.severity === 'high');
}

test('failed imported parameter initialization remains visible to deferred work', async t => {
  const findings = await high(t, {
    'reader.ts': `import fs from 'node:fs';function stop(){throw 0}export function read(first=(async()=>{await 0;second;fs.readFileSync('dead')})(),second=stop()){}`,
    'main.ts': `import http from 'node:http';import {read} from './reader.js';http.createServer(()=>read());`
  });
  assert.equal(findings.length, 0);
});

test('a local alias of an imported factory result remains a readable accumulator', async t => {
  const findings = await high(t, {
    'maker.ts': `export function make(){return [1]}`,
    'main.ts': `import http from 'node:http';import fs from 'node:fs';import {make} from './maker.js';const init=make();http.createServer(()=>[0].reduce(acc=>{acc.forEach(()=>fs.readFileSync('live'));return acc},init));`
  });
  assert.equal(findings.length, 1);
});

test('factory-produced source elements retain cross-file array identity', async t => {
  const findings = await high(t, {
    'maker.ts': `export function make(){return [1]}`,
    'main.ts': `import http from 'node:http';import fs from 'node:fs';import {make} from './maker.js';http.createServer(()=>[make()].reduce((acc,value)=>{value.forEach(()=>fs.readFileSync('live'));return acc},0));`
  });
  assert.equal(findings.length, 1);
});

test('cross-file duplicate fields honor a later instance assignment', async t => {
  const findings = await high(t, {
    'service.js': `export class Service{x=()=>{};x=()=>{}}`,
    'main.js': `import http from 'node:http';import fs from 'node:fs';import {Service} from './service.js';const service=new Service();service.x=()=>fs.readFileSync('live');http.createServer(()=>service.x());`
  });
  assert.equal(findings.length, 1);
});

test('two thousand empty constructor callbacks complete within unchanged work limits', async t => {
  const items = Array(2000).fill('1').join(',');
  const findings = await high(t, {
    'service.ts': `class Base{}export class Service extends Base{constructor(){super();[${items}].forEach(()=>{})}}`,
    'main.ts': `import http from 'node:http';import fs from 'node:fs';import {Service} from './service.js';http.createServer(()=>{new Service();fs.readFileSync('live')});`
  });
  assert.equal(findings.length, 1);
});

test('callback reuse preserves earlier work before later constructor failure', async t => {
  const findings = await high(t, {
    'service.ts': `import fs from 'node:fs';class Base{}export class Service extends Base{constructor(){[1,2].forEach(()=>{super();fs.readFileSync('live')})}}`,
    'main.ts': `import http from 'node:http';import {Service} from './service.js';http.createServer(()=>new Service());`
  });
  assert.equal(findings.length, 1);
});
