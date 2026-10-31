import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {scoreFindings,interpretScore} from '../dist/scoring.js';
import {renderMarkdown} from '../dist/reportMarkdown.js';
import {renderHtml} from '../dist/reportHtml.js';
import {runAudit} from '../dist/runner.js';

const finding=(severity='high',id='sync-io',category='I/O',confidence='medium')=>({
 id,category,severity,confidence,file:'server.ts',line:1,snippet:'',message:'blocking operation',scaleTrigger:'concurrent requests wait',suggestedFix:'use async I/O',
});
function report(findings=[],overrides={}){
 return {
  repo:'fixture',commit:null,scannedAt:'now',score:98,findings,notes:[],firstBottleneck:findings[0]??null,
  fingerprint:{framework:null,orm:null,projectType:'application',sourceFileCount:1,fileCount:1,deps:{},devDeps:{},hasTests:true,hasCI:true},
  summary:{total:findings.length,bySeverity:{},byCategory:{},byConfidence:{},categories:scoreFindings(findings).categories},
  ...overrides,
 };
}

test('score interpretation leaves the existing capped 98-point score unchanged',()=>{
 const findings=[...Array.from({length:37},()=>finding()),finding('low','outbound-no-timeout','Resilience','low'),finding('info','no-retry-strategy','Resilience','low')];
 assert.equal(scoreFindings(findings).score,98);
 const interpretation=interpretScore(findings,true);
 assert.equal(interpretation.model,'weighted-static-findings-v1');
 assert.equal(interpretation.familyPenaltyCap,20);assert.equal(interpretation.subsequentFindingMultiplier,.5);
 assert.equal(interpretation.highPriorityFindings,37);
 assert.deepEqual(interpretation.bySeverity,{critical:0,high:37,medium:0,low:1,info:1});
 assert.match(interpretation.reviewMessage,/37 high-priority.*regardless of the score/);
 assert.equal(scoreFindings(findings).score,98);
});

test('critical and low-confidence high findings still require review beside a high score',()=>{
 const interpretation=interpretScore([finding('critical'),finding('high','another','DB','low')]);
 assert.equal(interpretation.highPriorityFindings,2);
 assert.match(interpretation.reviewMessage,/1 critical, 1 high/);
 assert.deepEqual(interpretation.bySeverity,{critical:1,high:1,medium:0,low:0,info:0});
});

for(const renderer of [renderMarkdown,renderHtml])test(`${renderer.name} warns about high findings next to 98/100`,()=>{
 const value=report([finding()]);value.scoreInterpretation=interpretScore(value.findings,true);
 const text=renderer(value);
 assert.match(text,/98\/100/);assert.match(text,/High-priority review/);
 assert.match(text,/1 high-priority finding/);assert.match(text,/0 critical · 1 high · 0 medium · 0 low · 0 informational/);
 assert.ok(text.indexOf('High-priority review')<text.indexOf('First bottleneck'));
 assert.match(text,/Runtime capacity and production readiness remain unverified/);
 assert.match(text,/A category score of 100 means no scored findings were detected/);
 assert.match(text,/subsequent weights halve, capped at 20/);
});

for(const renderer of [renderMarkdown,renderHtml])test(`${renderer.name} derives older report warnings from findings rather than stale summaries`,()=>{
 const text=renderer(report([finding()],{summary:{total:0,bySeverity:{},byCategory:{},byConfidence:{},categories:[]}}));
 assert.match(text,/1 high-priority finding/);assert.match(text,/0 critical · 1 high/);
});

for(const renderer of [renderMarkdown,renderHtml])test(`${renderer.name} keeps incomplete audit warning before score and priorities`,()=>{
 const text=renderer(report([finding()],{complete:false}));
 assert.ok(text.indexOf('Incomplete audit')<text.indexOf('98/100'));
 assert.match(text,/Incomplete audit: some checks failed or source files were skipped/);
 assert.match(text,/1 high-priority finding/);
});

test('informational-only categories can score 100 with detected findings',()=>{
 const findings=[finding('info')],scores=scoreFindings(findings),interpretation=interpretScore(findings,true);
 assert.equal(scores.score,100);assert.equal(scores.categories.find(c=>c.category==='I/O').findings,1);
 assert.equal(interpretation.highPriorityFindings,0);assert.match(interpretation.reviewMessage,/1 informational finding/);
 assert.match(interpretation.categoryMeaning,/no scored findings/);
 assert.match(interpretation.reviewMessage,/capacity.*unverified/);
});

test('no findings does not claim verified runtime capacity or production readiness',()=>{
 const interpretation=interpretScore([],true);
 assert.deepEqual(interpretation.bySeverity,{critical:0,high:0,medium:0,low:0,info:0});
 assert.match(interpretation.reviewMessage,/No findings were detected by the current checks/);
 assert.match(interpretation.reviewMessage,/Runtime capacity and production readiness remain unverified/);
});

test('medium and low findings remain visible without inventing a passing verdict',()=>{
 const interpretation=interpretScore([finding('medium'),finding('low')],true);
 assert.equal(interpretation.highPriorityFindings,0);
 assert.match(interpretation.reviewMessage,/2 medium\/low finding\(s\) remain for review/);
 assert.doesNotMatch(interpretation.reviewMessage,/\bpass(?:ed)?\b/i);
});

test('HTML escapes additive explanation strings',()=>{
 const value=report([finding()]);value.scoreInterpretation=interpretScore(value.findings);
 value.scoreInterpretation.meaning='<script>meaning</script>';
 value.scoreInterpretation.reviewMessage='<img src=x onerror=alert(1)>';
 const html=renderHtml(value);
 assert.match(html,/&lt;script&gt;meaning&lt;\/script&gt;/);
 assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
 assert.doesNotMatch(html,/<script>meaning|<img src=x/);
});

test('runAudit emits additive score interpretation with complete severity accounting',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-score-interpretation-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'server.ts'),`import http from 'node:http';import fs from 'node:fs';http.createServer((req,res)=>{fs.readFileSync('data.json');res.end('ok')}).listen(3000);`);
 const value=await runAudit(root);assert.equal(value.complete,true,JSON.stringify(value.detectors));
 assert.equal(value.schemaVersion,1);
 const counts={critical:0,high:0,medium:0,low:0,info:0};for(const item of value.findings)counts[item.severity]++;
 assert.deepEqual(value.scoreInterpretation.bySeverity,counts);
 assert.equal(value.scoreInterpretation.highPriorityFindings,counts.critical+counts.high);
 assert.equal(value.score,scoreFindings(value.findings).score);
 assert.deepEqual(JSON.parse(JSON.stringify(value)).scoreInterpretation,value.scoreInterpretation);
});
