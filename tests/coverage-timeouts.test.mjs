import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runAudit } from '../dist/runner.js';
import { renderMarkdown } from '../dist/reportMarkdown.js';
import { renderHtml } from '../dist/reportHtml.js';

async function fixture(work) {
  const root = await mkdtemp(path.join(tmpdir(), 'scale-regression-'));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('coverage accounts for oversized, invalid and empty source without claiming complete analysis', async () => fixture(async root => {
  await writeFile(path.join(root, 'huge.ts'), ' '.repeat(1_000_001));
  await writeFile(path.join(root, 'invalid.ts'), 'const = ;');
  await writeFile(path.join(root, 'empty.ts'), '');
  const report = await runAudit(root);
  assert.equal(report.coverage.discovered, 3);
  assert.equal(report.coverage.analyzed, 1);
  assert.deepEqual(report.coverage.skipped.map(s => s.file), ['huge.ts', 'invalid.ts']);
  assert.match(report.coverage.skipped[0].reason, /1000000/);
  assert.match(report.coverage.skipped[1].reason, /syntax/);
  assert.ok(report.notes.some(n => /Incomplete source coverage/.test(n)));
  for (const render of [renderMarkdown, renderHtml]) {
    assert.match(render(report), /1\/3 analyzed; 2 skipped/);
    assert.match(render(report), /Incomplete source coverage/);
  }
}));

test('zero-source reports explicitly warn about missing coverage', async () => fixture(async root => {
  const report = await runAudit(root);
  assert.equal(report.coverage.analyzed, 0);
  assert.match(renderMarkdown(report), /Incomplete source coverage/);
  assert.match(renderHtml(report), /Incomplete source coverage/);
}));

test('mts and cts files are analyzed, declarations excluded, single-file CLI scopes findings and fixes', async () => fixture(async root => {
  for (const file of ['one.mts', 'two.cts', 'types.d.mts', 'types.d.cts']) {
    await writeFile(path.join(root, file), "fetch('https://example.com');\n");
  }
  const all = await runAudit(root);
  assert.equal(all.coverage.analyzed, 2);
  assert.equal(all.findings.filter(f => f.id === 'outbound-no-timeout').length, 2);
  for (const name of ['one.mts', 'two.cts']) {
    const file = path.join(root, name);
    const single = await runAudit(file);
    assert.equal(single.coverage.discovered, 1);
    assert.equal(single.coverage.analyzed, 1);
    assert.ok(single.findings.every(f => f.file === name));
    const output = execFileSync(process.execPath, ['dist/cli.js', file, '--fix'], { encoding: 'utf8' });
    const fixed = JSON.parse(output);
    assert.deepEqual(fixed.codemod.files, [name]);
    assert.equal(fixed.codemod.appliedEdits, 1);
  }
  await assert.rejects(runAudit(path.join(root, 'types.d.cts')), /Unsupported source/);
}));

test('timeout detection respects method signatures, supported options and actual client defaults', async () => fixture(async root => {
  const lines = [
    "import axios from 'axios';",
    "const api = axios.create({ timeout: 5000 });",
    "axios.post('url', {}, { timeout: 5000 });", // bounded
    "axios.put('url', {}, { timeout: 5000 });",
    "axios.patch('url', {}, { timeout: 5000 });",
    "axios.request({ url: 'url', timeout: 5000 });",
    "axios('url', { timeout: 5000 });",
    "api.get('url');",
    "axios.get('url');", // not covered by api defaults
    "api.get('url', { timeout: 0 });",
    "axios.get('url', { timeout: 0 });",
    "fetch('url', { timeout: 5000 });",
    "fetch('url', { timeoutMs: 5000 });",
    "fetch('url', { signal: AbortSignal.timeout(5000) });",
    "fetch('url', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });",
    "fetch('url', { signal: controller.signal });",
    "fetch('url', { signal: AbortSignal.timeout(ms) });",
    "axios.get('url', { timeout: ms });",
    "axios.get('url', { ...options });",
    "axios.get('url', { timeout: 5000, ...options });",
    "axios.get('url', { ...options, timeout: 5000 });",
    "http.request({ timeout: 5000 }, callback);",
    "http.request('url', { signal: AbortSignal.timeout(5000) }, callback);",
    "axios.get('url', { timeout: -1 });",
  ];
  await writeFile(path.join(root, 'server.ts'), lines.join('\n'));
  const report = await runAudit(root);
  const findings = report.findings.filter(f => f.id === 'outbound-no-timeout');
  assert.deepEqual(findings.map(f => f.line).sort((a,b) => a-b), [9,10,11,12,13,16,17,18,19,20,22,24]);
  for (const line of [18,19,20]) assert.equal(findings.find(f => f.line === line).confidence, 'low');
}));
