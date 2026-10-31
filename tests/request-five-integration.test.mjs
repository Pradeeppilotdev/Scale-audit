import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {runAudit} from '../dist/runner.js';

async function high(t, files) {
  const root = await mkdtemp('/tmp/scale-five-integration-');
  t.after(() => rm(root, {recursive: true, force: true}));
  for (const [name, source] of Object.entries(files)) await writeFile(`${root}/${name}`, source);
  const report = await runAudit(root);
  assert.equal(report.complete, true);
  assert.equal(report.coverage.analyzed, Object.keys(files).length);
  return report.findings.filter(finding => finding.id === 'sync-io' && finding.severity === 'high');
}

test('imported generator destructuring defaults execute in the request', async t => {
  const findings = await high(t, {
    'reader.ts': `import fs from 'node:fs';export function* read({value=fs.readFileSync('live')}={}){}`,
    'main.ts': `import http from 'node:http';import {read} from './reader.js';http.createServer(()=>read());`
  });
  assert.equal(findings.length, 1);
});

test('imported reducer arrays neither invoke elements nor permit a dead handler tail', async t => {
  const findings = await high(t, {
    'reader.ts': `import fs from 'node:fs';export const callbacks=[()=>fs.readFileSync('dead-callback')];`,
    'main.ts': `import http from 'node:http';import fs from 'node:fs';import {callbacks} from './reader.js';http.createServer(()=>{[0].reduce(callbacks,0);fs.writeFileSync('dead-tail','x')});`
  });
  assert.equal(findings.length, 0);
});

test('imported constructors cannot call fields before their installation', async t => {
  const findings = await high(t, {
    'service.ts': `import fs from 'node:fs';export class Service{first=this.later();later=()=>fs.readFileSync('dead-field')}`,
    'main.ts': `import http from 'node:http';import fs from 'node:fs';import {Service} from './service.js';http.createServer(()=>{new Service();fs.writeFileSync('dead-tail','x')});`
  });
  assert.equal(findings.length, 0);
});

test('imported constructors preserve compact array callback cardinality', async t => {
  const findings = await high(t, {
    'service.ts': `class Base{}export class Service extends Base{constructor(){Array.from(Array(2),()=>super())}}`,
    'main.ts': `import http from 'node:http';import fs from 'node:fs';import {Service} from './service.js';http.createServer(()=>{new Service();fs.readFileSync('dead')});`
  });
  assert.equal(findings.length, 0);
});

test('imported constructors retain native reduction initialization effects', async t => {
  const findings = await high(t, {
    'service.ts': `class Base{}export class Service extends Base{constructor(){[1].reduce(()=>super(),0)}}`,
    'main.ts': `import http from 'node:http';import fs from 'node:fs';import {Service} from './service.js';http.createServer(()=>{new Service();fs.readFileSync('live')});`
  });
  assert.equal(findings.length, 1);
});

test('ordinary large field lists complete within the unchanged work budget', async t => {
  const fields = Array.from({length: 1000}, (_, index) => `field${index}=0;`).join('');
  const findings = await high(t, {
    'service.ts': `export class Service{${fields}}`,
    'main.ts': `import http from 'node:http';import fs from 'node:fs';import {Service} from './service.js';http.createServer(()=>{new Service();fs.readFileSync('live')});`
  });
  assert.equal(findings.length, 1);
});
