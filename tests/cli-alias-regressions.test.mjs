import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readFile, writeFile, rm, access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const source = "export async function GET(){return fetch('https://example.com')}\n";
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scale-cli-alias-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const file = path.join(root, 'server.ts');
  await writeFile(file, source);
  return {root, file};
}

for (const alias of ['--verify', '-v']) {
  for (const args of [['--fix', alias], [alias, '--fix']]) {
    test(`${args.join(' ')} rejects before writing source or report`, async t => {
      const {root, file} = await fixture(t);
      const out = path.join(root, 'report.json');
      const result = spawnSync(process.execPath, [cli, root, ...args, '--out', out], {encoding: 'utf8'});
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /--fix and --diff cannot be combined/);
      assert.equal(result.stdout, '');
      assert.equal(await readFile(file, 'utf8'), source);
      await assert.rejects(access(out));
    });
  }
  test(`${alias} remains a non-mutating diff alias`, async t => {
    const {root, file} = await fixture(t);
    const result = spawnSync(process.execPath, [cli, root, alias], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /deprecated/);
    assert.match(result.stdout, /^--- a\/server\.ts/m);
    assert.match(result.stdout, /AbortSignal\.timeout/);
    assert.equal(await readFile(file, 'utf8'), source);
  });
}
