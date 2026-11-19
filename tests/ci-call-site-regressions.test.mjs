import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
async function gate(t, code, expectedExit) {
  const root = await mkdtemp(join(tmpdir(), 'scale-ci-site-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  await writeFile(join(root, 'route.mjs'), "import {readFileSync} from 'node:fs';\n" + code);
  const cliRun = spawnSync(process.execPath, [cli, root, '--fail-on', 'high'], {encoding:'utf8'});
  assert.equal(cliRun.status, expectedExit, cliRun.stderr);
  const report = JSON.parse(cliRun.stdout);
  assert.equal(report.complete, true);
  return report.findings.filter(finding => finding.id === 'sync-io');
}

const background = "function background(){return readFileSync('fixture');}";
const handler = "export function GET(){return readFileSync('fixture');}";
for (const bodies of [[background, handler], [handler, background]]) {
  for (const separator of [' ', '\n']) {
    test(`the high CI gate retains both I/O sites with ${separator === ' ' ? 'one' : 'two'} lines and ${bodies[0] === handler ? 'handler' : 'background'} first`, async t => {
      const finds = await gate(t, bodies.join(separator), 2);
      assert.deepEqual(finds.map(f => f.severity), ['high', 'medium']);
      assert.equal(new Set(finds.map(f => [f.line, f.column].join('/'))).size, 2);
    });
  }
}

for (const [name, code, expected] of [
  ['switched to local', 'let read=readFileSync; read=x=>x;', 0],
  ['switched to native', 'let read=x=>x; read=readFileSync;', 2],
  ['captured native', 'let selected=readFileSync; const read=selected; selected=x=>x;', 2],
  ['captured local', 'let selected=x=>x; const read=selected; selected=readFileSync;', 0],
]) test(`the high CI gate uses the current I/O binding when ${name}`, async t => {
  const finds = await gate(t, `export function GET(){${code}return read('fixture');}`, expected);
  assert.equal(finds.length, Number(expected === 2));
});
