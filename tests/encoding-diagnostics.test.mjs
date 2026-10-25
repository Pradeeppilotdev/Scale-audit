import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readRepoFile, readRepoFileSync } from '../dist/repoFiles.js';
import { runAudit } from '../dist/runner.js';
import { AnalysisBudget, AnalysisLimitError } from '../dist/analysisBudget.js';

async function fixture(fn) {
  const root=await mkdtemp(path.join(tmpdir(),'scale-encoding-'));
  try { return await fn(root); } finally { await rm(root,{recursive:true,force:true}); }
}
const source="export async function GET(){\r\n const label='café 日本語 😀';\r\n return fetch('https://example.com');\r\n}\r\n";
function encode(text,encoding) {
  if(encoding==='utf8') return Buffer.from(text);
  if(encoding==='utf8-bom') return Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(text)]);
  const body=Buffer.from(text,'utf16le');
  return Buffer.concat([Buffer.from(encoding==='le'?[0xff,0xfe]:[0xfe,0xff]),encoding==='le'?body:body.swap16()]);
}
for(const encoding of ['utf8','utf8-bom','le','be']) test(`${encoding} decoding, findings and safe fix behavior`,async()=>fixture(async root=>{
  const bytes=encode(source,encoding),file=path.join(root,'route.ts');
  await writeFile(file,bytes);
  const expected=encoding==='utf8-bom'?'\ufeff'+source:source;
  assert.equal(await readRepoFile(root,'route.ts'),expected);
  assert.equal(readRepoFileSync(root,'route.ts'),expected);
  assert.equal(await readRepoFile(root,'route.ts',bytes.length-1),null);
  assert.equal(readRepoFileSync(root,'route.ts',bytes.length-1),null);
  const report=await runAudit(root,{codemod:'apply'});
  assert.equal(report.complete,true);
  const finding=report.findings.find(f=>f.id==='outbound-no-timeout');
  assert.ok(finding);
  assert.equal(finding.line,3);
  if(encoding==='le'||encoding==='be') {
    assert.equal(report.codemod.applied,false);
    assert.equal(report.codemod.manual.length,1);
    assert.deepEqual(await readFile(file),bytes);
  } else {
    assert.equal(report.codemod.applied,true);
    assert.equal((await runAudit(root)).findings.some(f=>f.id==='outbound-no-timeout'),false);
    if(encoding==='utf8-bom') assert.deepEqual((await readFile(file)).subarray(0,3),Buffer.from([0xef,0xbb,0xbf]));
  }
}));

test('malformed odd-length UTF-16 stays skipped and strict',async()=>fixture(async root=>{
  await writeFile(path.join(root,'route.ts'),Buffer.from([0xff,0xfe,0x65]));
  assert.equal(await readRepoFile(root,'route.ts'),null);
  assert.equal(readRepoFileSync(root,'route.ts'),null);
  const report=await runAudit(root);
  assert.equal(report.complete,false);
  assert.equal(report.coverage.skipped.length,1);
}));

test('typed limit errors retain actionable reasons',()=>{
  assert.throws(()=>new AnalysisBudget('Probe',0).take(),error=>error instanceof AnalysisLimitError&&error.message==='Probe analysis work budget exceeded');
});

test('unexpected errors are private in reports and available only to diagnostic callback',async()=>fixture(async root=>{
  await writeFile(path.join(root,'route.ts'),source);
  const secret='private-token-and-path',original=AnalysisBudget.prototype.take;
  AnalysisBudget.prototype.take=function(count=1){
    if(this.label==='Factory call graph') throw new TypeError(secret);
    return original.call(this,count);
  };
  const diagnostics=[];
  try {
    const report=await runAudit(root,{onDiagnostic:(name,error)=>diagnostics.push({name,error})});
    assert.equal(report.complete,false);
    assert.ok(report.detectors.some(d=>d.reason==='Detector failed internally'));
    assert.equal(JSON.stringify(report).includes(secret),false);
    assert.ok(diagnostics.some(d=>d.error instanceof TypeError&&d.error.stack.includes(secret)));
    const stillReported=await runAudit(root,{onDiagnostic:()=>{throw new Error('diagnostic failed');}});
    assert.equal(stillReported.complete,false);
  } finally { AnalysisBudget.prototype.take=original; }
}));

test('CLI --debug adds stack diagnostics to stderr without polluting JSON',async()=>fixture(async root=>{
  await writeFile(path.join(root,'route.ts'),`import {Injectable} from '@nestjs/common';@Injectable(${'('.repeat(512)}{}${')'.repeat(512)})class Database{}\n${source}`);
  const quiet=spawnSync(process.execPath,['dist/cli.js',root],{encoding:'utf8'});
  const debug=spawnSync(process.execPath,['dist/cli.js',root,'--debug'],{encoding:'utf8'});
  assert.equal(quiet.status,3);
  assert.equal(debug.status,3);
  assert.doesNotMatch(quiet.stderr,/staticValues\.js:/);
  assert.match(debug.stderr,/AnalysisLimitError/);
  assert.match(debug.stderr,/staticValues\.js:/);
  assert.equal(JSON.parse(debug.stdout).complete,false);
  assert.equal(JSON.parse(debug.stdout).findings.length,JSON.parse(quiet.stdout).findings.length);
}));

test('empty audit is incomplete by default',async()=>fixture(async root=>{
  const result=spawnSync(process.execPath,['dist/cli.js',root],{encoding:'utf8'});
  assert.equal(result.status,3);
  assert.equal(JSON.parse(result.stdout).complete,false);
}));
