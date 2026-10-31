import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {runAudit} from '../dist/runner.js';

async function high(t, files) {
  const root = await mkdtemp('/tmp/scale-latest-five-integration-');
  t.after(() => rm(root, {recursive: true, force: true}));
  for (const [name, source] of Object.entries(files)) await writeFile(`${root}/${name}`, source);
  const report = await runAudit(root);
  assert.equal(report.complete, true);
  assert.equal(report.coverage.analyzed, Object.keys(files).length);
  return report.findings.filter(finding => finding.id === 'sync-io' && finding.severity === 'high');
}

test('imported generators receive an empty array for destructured rest defaults', async t => {
  const findings = await high(t, {
    'reader.ts': `import fs from 'node:fs';export function* read(...[value=fs.readFileSync('live')]){}`,
    'main.ts': `import http from 'node:http';import {read} from './reader.js';http.createServer(()=>read());`
  });
  assert.equal(findings.length, 1);
});

test('uninitialized imported parameter bindings stop subsequent defaults', async t => {
  const findings = await high(t, {
    'reader.ts': `import fs from 'node:fs';export function* read({first=second,second=fs.readFileSync('dead')}={}){}`,
    'main.ts': `import http from 'node:http';import {read} from './reader.js';http.createServer(()=>read());`
  });
  assert.equal(findings.length, 0);
});

test('returned cross-file array accumulators preserve native callback evidence', async t => {
  const findings = await high(t, {
    'reader.ts': `export function make(){return [1]}`,
    'main.ts': `import http from 'node:http';import fs from 'node:fs';import {make} from './reader.js';http.createServer(()=>[0,0].reduce(acc=>{acc.forEach(()=>fs.readFileSync('live'));return make()},[]));`
  });
  assert.equal(findings.length, 1);
});

test('earlier imported constructor callback work survives a later duplicate super failure', async t => {
  const findings = await high(t, {
    'service.ts': `import fs from 'node:fs';class Base{}export class Service extends Base{constructor(){[1,2].forEach(()=>{super();fs.readFileSync('live')})}}`,
    'main.ts': `import http from 'node:http';import {Service} from './service.js';http.createServer(()=>new Service());`
  });
  assert.equal(findings.length, 1);
});

test('an imported class resolves the last installed duplicate field', async t => {
  const findings = await high(t, {
    'service.js': `import fs from 'node:fs';export class Service{x=()=>fs.readFileSync('dead');x=()=>{}}`,
    'main.js': `import http from 'node:http';import {Service} from './service.js';http.createServer(()=>new Service().x());`
  });
  assert.equal(findings.length, 0);
});

test('ordinary repeated constructor callbacks stay within the unchanged work budget', async t => {
  const items = Array(500).fill('1').join(',');
  const findings = await high(t, {
    'service.ts': `import fs from 'node:fs';class Base{}export class Service extends Base{constructor(){super();[${items}].forEach(()=>fs.readFileSync('live'))}}`,
    'main.ts': `import http from 'node:http';import {Service} from './service.js';http.createServer(()=>new Service());`
  });
  assert.equal(findings.length, 1);
});
