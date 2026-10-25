import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { detectSyncIo } from '../dist/detectors/syncIo.js';

async function audit(files, verify) {
  const root=await mkdtemp(path.join(tmpdir(),'scale-context-'));
  try {
    for(const [file,content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root,file)),{recursive:true});
      await writeFile(path.join(root,file),content);
    }
    await verify(await detectSyncIo(root));
  } finally {await rm(root,{recursive:true,force:true});}
}
const helper="import fs from 'node:fs'; export function read() { return fs.readFileSync('x'); }";
const cli="#!/usr/bin/env node\nimport {read} from './helper.js'; read();";

test('CLI runtime dependencies are informational, including re-exports and dynamic imports', async () => {
  await audit({
    'cli.mts':"#!/usr/bin/env node\nimport {read} from './barrel.mjs'; await import('./dynamic.cjs'); read();",
    'barrel.mts':"export {read} from './helper.js';",
    'helper.ts':helper,
    'dynamic.cts':helper,
  },findings=>{
    assert.equal(findings.length,2);
    assert.ok(findings.every(f=>f.severity==='info' && /CLI/.test(f.message)));
    assert.ok(findings.every(f=>/Keep safety checks intact/.test(f.suggestedFix)));
  });
});

test('package bin maps compiled output to TypeScript source without a shebang', async () => {
  await audit({
    'package.json':JSON.stringify({bin:{audit:'dist/entry.js'}}),
    'tsconfig.json':JSON.stringify({compilerOptions:{rootDir:'src',outDir:'dist'}}),
    'src/entry.ts':"import {read} from './helper.js'; read();",
    'src/helper.ts':helper,
  },findings=>assert.equal(findings[0].severity,'info'));
});

test('actual Node child-process and worker-thread URL launches identify isolated entry dependencies', async () => {
  for(const launch of [
    "import {spawn} from 'node:child_process'; spawn(process.execPath,[new URL('./background.js',import.meta.url).pathname]);",
    "import {Worker} from 'node:worker_threads'; new Worker(new URL('./background.js',import.meta.url));",
  ]) await audit({
    'server.ts':launch,
    'background.ts':"import {read} from './helper.js'; read();",
    'helper.ts':helper,
  },findings=>{
    assert.equal(findings.length,1);
    assert.equal(findings[0].severity,'info');
    assert.match(findings[0].message,/isolated worker/);
  });
});

test('request imports override CLI and worker hints through shared helpers', async () => {
  await audit({
    'cli.ts':cli,
    'server.ts':"import {read} from './helper.js'; app.get('/read',()=>read());",
    'helper.ts':helper,
  },findings=>{
    assert.equal(findings.length,1);
    assert.equal(findings[0].severity,'high');
    assert.match(findings[0].scaleTrigger,/reachable from a request entry/);
  });
});

test('type-only imports and exports do not imply request execution', async () => {
  for(const declaration of ["import type {Thing} from './helper.js';", "import {type Thing} from './helper.js';", "export type {Thing} from './helper.js';", "export {type Thing} from './helper.js';"])
    await audit({'cli.ts':cli,'helper.ts':helper,'server.ts':declaration}, findings=>assert.equal(findings[0].severity,'info'));
});

test('request registrations in script folders override script and CLI hints', async () => {
  await audit({
    'scripts/cli.ts':"#!/usr/bin/env node\nimport fs from 'node:fs'; app.get('/read',()=>fs.readFileSync('x'));",
  },findings=>{
    assert.equal(findings[0].severity,'high');
    assert.match(findings[0].suggestedFix,/async equivalent/);
  });
});

test('worker filename and unattached URL alone do not prove isolation', async () => {
  await audit({
    'backgroundWorker.ts':helper,
    'launcher.ts':"new URL('./backgroundWorker.js',import.meta.url);",
  },findings=>{
    assert.equal(findings[0].severity,'medium');
    assert.doesNotMatch(findings[0].message,/isolated/);
  });
});


test('aliased HTTP factories and request callback signatures keep warnings prominent', async () => {
  for (const entry of [
    "import {createServer as serve} from 'node:http'; import {read} from './helper.js'; serve(() => read());",
    "import {read} from './helper.js'; api.get('/read', (req, res) => read());",
  ]) await audit({'main.ts':entry,'helper.ts':helper},findings=>assert.equal(findings[0].severity,'high'));
});
