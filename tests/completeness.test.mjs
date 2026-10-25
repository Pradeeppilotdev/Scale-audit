import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { runAudit } from '../dist/runner.js';
import { projectWorkLimit, AnalysisBudget, AnalysisLimitError } from '../dist/analysisBudget.js';
import { renderMarkdown } from '../dist/reportMarkdown.js';
import { renderHtml } from '../dist/reportHtml.js';
import { createAuditProcessRunner } from '../dist/auditProcess.js';

async function fixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'scale-completeness-'));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const exhausted = `import {Injectable,Scope} from '@nestjs/common';
@Injectable(${'('.repeat(512)}{scope:Scope.REQUEST}${')'.repeat(512)})class Database{}
export async function GET(){ return fetch('https://example.com'); }`;

test('whole-project limits scale with AST size, retain a floor and a ceiling', () => {
  const source = ts.createSourceFile('large.ts', 'const x=1;'.repeat(4000), ts.ScriptTarget.Latest, true);
  assert.equal(projectWorkLimit([]), 200000);
  assert.ok(projectWorkLimit([source]) > 200000);
  assert.equal(projectWorkLimit(Array(20001).fill(source)), 20000000);
});

test('320-file DI repository exceeds old budget and completes with known findings', async () => fixture(async root => {
  await Promise.all(Array.from({length:320}, (_,i) => writeFile(path.join(root, `module${i}.ts`), `
import {container} from 'tsyringe'; import {Pool} from 'pg';
class Database { pool=new Pool(); }
container.register(Database,{useClass:Database});
${Array.from({length:80},(_,j)=>`function helper${j}(value){return value+${j};}`).join('\n')}
export function GET(req,res){ return container.resolve(Database); }
`)));
  // Demonstrate the fixture really exercises work beyond the old flat cap.
  const used = new Map(), instances = new WeakMap(), original = AnalysisBudget.prototype.take;
  AnalysisBudget.prototype.take = function(count=1) {
    const total=(instances.get(this)??0)+count;
    instances.set(this,total);
    used.set(this.label,Math.max(used.get(this.label)??0,total));
    return original.call(this,count);
  };
  let report;
  try { report=await runAudit(root); } finally { AnalysisBudget.prototype.take=original; }
  assert.equal(report.complete,true);
  assert.equal(report.coverage.analyzed,320);
  assert.ok(used.get('Factory call graph') > 200000, JSON.stringify([...used]));
  assert.equal(report.findings.filter(f=>f.id==='per-request-client').length,320);
}));

test('failed detector retains other findings and warns in JSON, Markdown and HTML', async () => fixture(async root => {
  await writeFile(path.join(root,'route.ts'),exhausted);
  const report=await runAudit(root);
  assert.equal(report.complete,false);
  assert.equal(report.detectors.length,12);
  assert.ok(report.detectors.some(d=>d.status==='failed'));
  assert.ok(report.detectors.some(d=>d.status==='complete'));
  assert.ok(report.findings.some(f=>f.id==='outbound-no-timeout'));
  assert.match(renderMarkdown(report),/Incomplete audit/);
  assert.match(renderHtml(report),/Incomplete audit/);
  const out=path.join(root,'report.json');
  const cli=spawnSync(process.execPath,['dist/cli.js',root,'--out',out,'--fail-on','info','--fix'],{encoding:'utf8'});
  assert.equal(cli.status,3,cli.stderr);
  const saved=JSON.parse(await readFile(out,'utf8'));
  assert.equal(saved.complete,false);
  assert.equal(saved.codemod.applied,false);
  assert.equal(await readFile(path.join(root,'route.ts'),'utf8'),exhausted);
  const runner=createAuditProcessRunner();
  try { const httpReport=await runner.audit(root); assert.equal(httpReport.complete,false); assert.ok(httpReport.findings.some(f=>f.id==='outbound-no-timeout')); }
  finally { runner.close(); }
}));

test('skipped source coverage is structurally incomplete and CLI exits 3', async () => fixture(async root => {
  await writeFile(path.join(root,'invalid.ts'),'export const = ;');
  const cli=spawnSync(process.execPath,['dist/cli.js',root],{encoding:'utf8'});
  assert.equal(cli.status,3,cli.stderr);
  assert.equal(JSON.parse(cli.stdout).complete,false);
}));


test('4500-file repository completes all detectors and CLI report output', async () => fixture(async root => {
  // Write in batches rather than requiring thousands of simultaneous descriptors.
  for(let start=0;start<4500;start+=100) {
    await Promise.all(Array.from({length:Math.min(100,4500-start)},(_,offset)=>{
      const i=start+offset;
      return writeFile(path.join(root,`service${i}.ts`),`export function helper(value){return value+${i};}\n`);
    }));
  }
  await writeFile(path.join(root,'route.ts'),"export async function GET(){return fetch('https://example.com');}");
  const out=path.join(root,'report.json');
  const cli=spawnSync(process.execPath,['dist/cli.js',root,'--out',out],{encoding:'utf8',timeout:60000});
  assert.equal(cli.status,0,cli.stderr);
  const report=JSON.parse(await readFile(out,'utf8'));
  assert.equal(report.complete,true);
  assert.equal(report.coverage.analyzed,4501);
  assert.ok(report.detectors.every(d=>d.status==='complete'));
  assert.ok(report.findings.some(f=>f.id==='outbound-no-timeout'));
}));

test('exhausted work budget produces explicit failed detector status', async () => fixture(async root => {
  await writeFile(path.join(root,'route.ts'),"export async function GET(){return fetch('https://example.com');}");
  const original=AnalysisBudget.prototype.take;
  AnalysisBudget.prototype.take=function(count=1){
    if(this.label==='Factory call graph') throw new AnalysisLimitError('Factory call graph analysis work budget exceeded');
    return original.call(this,count);
  };
  let report;
  try { report=await runAudit(root); } finally { AnalysisBudget.prototype.take=original; }
  assert.equal(report.complete,false);
  assert.ok(report.detectors.some(d=>d.status==='failed'&&d.reason==='Factory call graph analysis work budget exceeded'));
  assert.ok(report.findings.some(f=>f.id==='outbound-no-timeout'));
}));
