import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {runAudit} from '../dist/runner.js';

test('the analyzer completes its own startup analysis within unchanged work limits', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const report = await runAudit(root);
  assert.equal(report.complete, true, JSON.stringify(report.detectors));
  assert.ok(report.coverage.analyzed > 0);
  assert.equal(report.coverage.skipped.length, 0);
});
