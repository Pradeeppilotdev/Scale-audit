import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {runAudit} from '../dist/runner.js';

const head = `import express from 'express';const app=express();`;
const protect = `process.on('SIGTERM',()=>{});app.get('/health',()=> 'ok');`;
async function audit(t, source) {
  const root = await mkdtemp('/tmp/scale-startup-release-regression-');
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(root + '/package.json', JSON.stringify({type: 'module', dependencies: {express: '*'}}));
  await writeFile(root + '/main.ts', head + source);
  const report = await runAudit(root);
  assert.equal(report.complete, true, JSON.stringify(report.detectors));
  return report.findings;
}
function expectProtection(findings, protectedStartup) {
  for (const id of ['missing-graceful-shutdown', 'missing-health-endpoint'])
    assert.equal(findings.some(finding => finding.id === id), !protectedStartup, id);
}
for (const completion of ['return', 'throw']) for (const expression of ['new Promise(()=>{})', 'load()']) {
  test(`${completion} await ${expression} cannot establish detached finally protection`, async t => {
    const findings = await audit(t, `async function setup(){try{${completion} await ${expression}}finally{${protect}}}setup();app.listen(3000);`);
    expectProtection(findings, false);
  });
}
test('awaited returned operand completes before finally and listener', async t => {
  const findings = await audit(t, `async function setup(){try{return await load()}finally{${protect}}}await setup();app.listen(3000);`);
  expectProtection(findings, true);
});
for (const tail of ['property', 'method()']) for (const registration of [
  `process.on('SIGTERM',()=>{})`, `app.get('/health',()=> 'ok')`,
]) test(`unknown optional ${tail} guards computed registration ${registration}`, async t => {
  const findings = await audit(t, `declare const maybe:any;maybe?.${tail}[${registration}]();app.listen(3000);`);
  assert.ok(findings.some(f => f.id === (registration.startsWith('process') ? 'missing-graceful-shutdown' : 'missing-health-endpoint')));
});
test('known-present optional receiver executes a later computed key', async t => {
  const findings = await audit(t, `const target={property:{}};target?.property[(${protect.replace(/;$/,'').replace(';',',')},'key')]();app.listen(3000);`);
  expectProtection(findings, true);
});
test('unconditional optional receiver evaluation retains protection evidence', async t => {
  const findings = await audit(t, `declare const maybe:any;(${protect.replace(/;$/,'').replace(';',',')},maybe)?.property[key]();app.listen(3000);`);
  expectProtection(findings, true);
});
for (const body of [`throw Error('expected')`, `return`]) test(`finally return overrides prior ${body}`, async t => {
  const findings = await audit(t, `function validate(){try{${body}}finally{return}}validate();${protect}app.listen(3000);`);
  expectProtection(findings, true);
});
test('conditional finally return does not erase an uncaught throw path', async t => {
  const findings = await audit(t, `function validate(){try{throw Error('expected')}finally{if(enabled)return}}validate();${protect}app.listen(3000);`);
  expectProtection(findings, false);
});
test('finally throw overrides prior return and prevents subsequent setup', async t => {
  const findings = await audit(t, `function validate(){try{return}finally{throw Error('failed')}}validate();${protect}app.listen(3000);`);
  expectProtection(findings, false);
});
test('pending returned finally operand cannot complete earlier throw', async t => {
  const findings = await audit(t, `async function setup(){try{throw Error('expected')}finally{return await new Promise(()=>{});${protect}}}setup();app.listen(3000);`);
  expectProtection(findings, false);
});
