import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {runAudit} from '../dist/runner.js';

async function audit(t, files) {
  const root = await mkdtemp('/tmp/scale-eight-integration-');
  t.after(() => rm(root, {recursive: true, force: true}));
  for (const [name, source] of Object.entries(files)) await writeFile(`${root}/${name}`, source);
  const report = await runAudit(root);
  assert.equal(report.complete, true);
  assert.equal(report.coverage.analyzed, Object.keys(files).length);
  return report.findings.filter(finding => finding.id === 'sync-io' && finding.severity === 'high');
}

test('cross-file async factories cannot register their eventual returned handler', async t => {
  const findings = await audit(t, {
    'handlers.ts': `import fs from 'node:fs'; export async function make(){return()=>fs.readFileSync('dead')}`,
    'main.ts': `import http from 'node:http';import {make} from './handlers.js';http.createServer(make().bind(null));`
  });
  assert.equal(findings.length, 0);
});

test('cross-file throwing guards suppress body and subsequent request work', async t => {
  const findings = await audit(t, {
    'helpers.ts': `export function stop(){throw 0}`,
    'main.ts': `import http from 'node:http';import fs from 'node:fs';import {stop} from './helpers.js';http.createServer(()=>{while(stop())fs.readFileSync('dead-body');fs.writeFileSync('dead-tail','x')});`
  });
  assert.equal(findings.length, 0);
});

test('cross-file throwing reducers suppress subsequent request work', async t => {
  const findings = await audit(t, {
    'helpers.ts': `export function reduce(acc,value){throw 0}`,
    'main.ts': `import http from 'node:http';import fs from 'node:fs';import {reduce} from './helpers.js';http.createServer(()=>{[1].reduce(reduce,0);fs.readFileSync('dead')});`
  });
  assert.equal(findings.length, 0);
});

test('cross-file constructors retain skipped optional arguments and synchronous super helpers', async t => {
  const findings = await audit(t, {
    'service.ts': `class Base{};export class Service extends Base{constructor(){null?.run(this);const init=()=>super();init.call(null)}}`,
    'main.ts': `import http from 'node:http';import fs from 'node:fs';import {Service} from './service.js';http.createServer(()=>{new Service();fs.readFileSync('live')});`
  });
  assert.equal(findings.length, 1);
});
