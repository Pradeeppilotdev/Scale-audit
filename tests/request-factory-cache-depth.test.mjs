import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {Workspace} from '../dist/workspace.js';
import {requestReachability} from '../dist/requestReachability.js';
import {AnalysisLimitError} from '../dist/analysisBudget.js';
import {runAudit} from '../dist/runner.js';

async function fixture(t,body){
 const root=await mkdtemp('/tmp/scale-factory-cache-depth-');t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(root+'/main.ts',`import http from 'node:http';import fs from 'node:fs';${body}`);
 return Workspace.load(root);
}
function factories(warm,aliases=40,wrappers=20){
 return `const a0=()=>{};${Array.from({length:aliases},(_,index)=>`const a${index+1}=(a${index});`).join('')}`+
  `function leaf(){return a${aliases}}function outer(){return ${'('.repeat(wrappers)}leaf()${')'.repeat(wrappers)}}http.createServer(outer());${warm?'http.createServer(leaf());':''}`;
}
const depthFailure=error=>error instanceof AnalysisLimitError&&/Request binding resolution depth limit exceeded/.test(error.message);
for(const warm of[false,true])test('factory binding depth remains strict with '+(warm?'warm':'cold')+' returned callback summaries',async t=>{
 const ws=await fixture(t,factories(warm));
 assert.throws(()=>requestReachability(ws),depthFailure);
});
for(const warm of[false,true])test('bound callback cache retains '+(warm?'warm':'cold')+' binding depth cost',async t=>{
 const aliases=Array.from({length:40},(_,index)=>`const a${index+1}=(a${index});`).join('');
 const ws=await fixture(t,`const a0=()=>{};${aliases}let handler;handler=a40.bind(null);function outer(){return${'('.repeat(20)}handler${')'.repeat(20)}}http.createServer(outer());${warm?'http.createServer(handler);':''}`);
 assert.throws(()=>requestReachability(ws),depthFailure);
});
test('factory depth exhaustion stays incomplete and repeats with the same workspace',async t=>{
 const ws=await fixture(t,factories(true));const report=await runAudit(ws.root);
 assert.equal(report.complete,false);
 assert.ok(report.detectors.some(check=>check.name==='detectSyncIo'&&check.status==='failed'&&/Request binding resolution depth limit exceeded/.test(check.reason)));
 assert.throws(()=>requestReachability(ws),depthFailure);
 assert.throws(()=>requestReachability(ws),depthFailure);
});
test('shallow warmed factory callbacks remain reusable',async t=>{
 const ws=await fixture(t,factories(true,12,8));
 assert.doesNotThrow(()=>requestReachability(ws));
});
test('factory summaries preserve different captured callback arguments',async t=>{
 const ws=await fixture(t,`function wrap(fn){return()=>fn()}function read(){fs.readFileSync('live')}function unused(){fs.writeFileSync('dead','x')}const one=wrap(read);const two=wrap(unused);http.createServer(one);`);
 const report=await runAudit(ws.root);assert.equal(report.complete,true);
 const high=report.findings.filter(finding=>finding.id==='sync-io'&&finding.severity==='high');
 assert.equal(high.length,1);assert.match(high[0].message,/readFileSync/);
});
test('recursive factory uncertainty cannot donate a stale callback to another result',async t=>{
 const ws=await fixture(t,`function loop(){return loop()}function read(){fs.readFileSync('live')}http.createServer(loop());http.createServer(read);`);
 const report=await runAudit(ws.root);assert.equal(report.complete,true);
 assert.equal(report.findings.filter(finding=>finding.id==='sync-io'&&finding.severity==='high').length,1);
});
test('repeated ordinary factory registrations share their completed result',async t=>{
 const ws=await fixture(t,`function read(){fs.readFileSync('live')}function wrap(fn){return()=>fn()}const handler=wrap(read);${'http.createServer(handler);'.repeat(100)}`);
 const report=await runAudit(ws.root);assert.equal(report.complete,true);
 assert.equal(report.findings.filter(finding=>finding.id==='sync-io'&&finding.severity==='high').length,1);
});
