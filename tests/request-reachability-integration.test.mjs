import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {detectSyncIo} from '../dist/detectors/syncIo.js';
import {runAudit} from '../dist/runner.js';
import {renderMarkdown} from '../dist/reportMarkdown.js';
import {renderHtml} from '../dist/reportHtml.js';

async function audit(t,files,report=false){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-request-reachability-integration-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 for(const[name,source]of Object.entries(files)){
  await mkdir(path.dirname(path.join(root,name)),{recursive:true});
  await writeFile(path.join(root,name),source);
 }
 return report?runAudit(root):(await detectSyncIo(root)).filter(finding=>finding.id==='sync-io');
}
const high=findings=>findings.filter(finding=>finding.severity==='high');

test('nanpolis-shaped HTTP callbacks reach API and demo I/O without promoting unused imported helpers',async t=>{
 const findings=await audit(t,{
  'package.json':'{"type":"module"}',
  'agent/src/api.ts':`import http from 'node:http';import fs from 'node:fs';import {window,parse}from './nansen.js';import{sampleSnapshot}from './replay.js';
function readJson(file){return JSON.parse(fs.readFileSync(file,'utf8'))}
function history(){if(!fs.existsSync('fixtures'))return[];return fs.readdirSync('fixtures').map(name=>parse(readJson(name)))}
function apiResponse(url){if(url==='/history')return history();if(url==='/protections')return fs.existsSync('protections')?readJson('protections'):[];return sampleSnapshot()}
export function createApi(){return http.createServer((req,res)=>{res.end(JSON.stringify(apiResponse(req.url)))})}createApi().listen(3000);`,
  'agent/src/nansen.ts':`import{mkdirSync,writeFileSync}from'node:fs';import{execFileSync}from'node:child_process';export const window=60;export function parse(value){return value}export function ensureDir(){mkdirSync('data')}export function fetchData(){return execFileSync('curl',[])}export function probe(){return execFileSync('probe',[])}export function save(){writeFileSync('data','x')}`,
  'agent/src/replay.ts':`import fs from'node:fs';const config=fs.readFileSync('config','utf8');export function sampleSnapshot(){return fs.readdirSync('samples').map(name=>fs.readFileSync(name,'utf8'))}`,
 });
 assert.equal(findings.length,11);
 assert.equal(high(findings).filter(f=>f.file==='agent/src/api.ts').length,4);
 assert.equal(high(findings).filter(f=>f.file==='agent/src/replay.ts').length,2);
 assert.equal(high(findings).filter(f=>f.file==='agent/src/nansen.ts').length,0);
 assert.equal(findings.find(f=>f.file==='agent/src/replay.ts'&&f.line===1)?.severity,'low');
});

test('aliased re-exported helpers retain cross-file request invocation identity',async t=>{
 const findings=await audit(t,{
  'api.ts':`import{load as read}from'./barrel.js';const call=read;app.get('/data',()=>call());`,
  'barrel.ts':`export{read as load}from'./store.js';`,
  'store.ts':`import fs from'node:fs';export function read(){return fs.readFileSync('live')}export function unused(){return fs.writeFileSync('offline','x')}`,
 });
 assert.equal(findings.length,2);assert.equal(high(findings).length,1);
 assert.match(high(findings)[0].message,/readFileSync/);
});

test('called helper callback parameters retain request execution',async t=>{
 const findings=await audit(t,{
  'api.ts':`import{read}from'./store.js';function respond(loader){return loader()}app.get('/data',()=>respond(read));`,
  'store.ts':`import fs from'node:fs';export function read(){return fs.readFileSync('live')}`,
 });
 assert.equal(high(findings).length,1);
});

for(const receiver of ['safe','unsafe'])test('same-named methods on distinct objects retain identity: '+receiver,async t=>{
 const findings=await audit(t,{'api.ts':`import fs from'node:fs';const unsafe={read(){return fs.readFileSync('live')}};const safe={read(){return'ok'}};app.get('/data',()=>${receiver}.read());`});
 assert.equal(findings.length,1);assert.equal(high(findings).length,receiver==='unsafe'?1:0);
});

test('a replaced method cannot seed stale request reachability for its original body',async t=>{
 const findings=await audit(t,{'main.ts':`import http from'node:http';import fs from'node:fs';const api={read(){return fs.readFileSync('live')}};api.read=()=>{};http.createServer(()=>api.read()).listen(3000);`});
 assert.equal(findings.length,1);assert.equal(high(findings).length,0);
});

for(const replacement of [
 `Object.assign(api,{read:()=>0});`,
 `function change(target){target.read=()=>0}change(api);`,
])test('indirect method replacement cannot seed stale request work: '+replacement,async t=>{
 const findings=await audit(t,{'main.ts':`import http from'node:http';import fs from'node:fs';const api={read(){return fs.readFileSync('live')}};${replacement}http.createServer(()=>api.read()).listen(3000);`});
 assert.equal(findings.length,1);assert.equal(high(findings).length,0);
});

for(const callback of ['api.read','()=>read()'])test('stable method callback references retain request work: '+callback,async t=>{
 const findings=await audit(t,{'main.ts':`import http from'node:http';import fs from'node:fs';const api={read(){return fs.readFileSync('live')}};const read=api.read;http.createServer(${callback}).listen(3000);`});
 assert.equal(high(findings).length,1);
});

test('a stable method can delegate request work through its this receiver',async t=>{
 const findings=await audit(t,{'main.ts':`import http from'node:http';import fs from'node:fs';const api={read(){return this.load()},load(){return fs.readFileSync('live')}};http.createServer(()=>api.read()).listen(3000);`});
 assert.equal(high(findings).length,1);
});

test('an inspectable read-only helper preserves its object argument request work',async t=>{
 const findings=await audit(t,{'main.ts':`import http from'node:http';import fs from'node:fs';const api={read(){return fs.readFileSync('live')}};function run(service){return service.read()}http.createServer(()=>run(api)).listen(3000);`});
 assert.equal(high(findings).length,1);
});

test('Fastify route object handler references seed actual request work',async t=>{
 const findings=await audit(t,{
  'main.ts':`import fastify from'fastify';import{read}from'./store.js';const server=fastify();server.route({method:'GET',url:'/data',handler:read});`,
  'store.ts':`import fs from'node:fs';export function read(){return fs.readFileSync('live')}`,
 });
 assert.equal(high(findings).length,1);
});

for(const entry of [
 `import http from'node:http';import{read}from'./store.js';new http.Server(read).listen(3000);`,
 `import{Server as NativeServer}from'node:http';import{read}from'./store.js';new NativeServer(read).listen(3000);`,
])test('native HTTP Server constructor callback references seed request work: '+entry.slice(0,48),async t=>{
 const findings=await audit(t,{'main.ts':entry,'store.ts':`import fs from'node:fs';export function read(){return fs.readFileSync('live')}`});
 assert.equal(high(findings).length,1);
});

for(const event of ['request','close'])test('HTTP server event callback uses the event execution role: '+event,async t=>{
 const findings=await audit(t,{
  'main.ts':`import http from'node:http';import{read}from'./store.js';const server=http.createServer();server.on('${event}',read);server.listen(3000);`,
  'store.ts':`import fs from'node:fs';export function read(){return fs.readFileSync('live')}`,
 });
 assert.equal(findings.length,1);assert.equal(high(findings).length,event==='request'?1:0);
});

for(const[label,body,expected]of[
 ['known false registration',`if(false)http.createServer(()=>fs.readFileSync('live'));`,0],
 ['uncalled private factory',`function unused(){return http.createServer(()=>fs.readFileSync('live'))}`,0],
 ['exported server factory',`export function createApi(){return http.createServer(()=>fs.readFileSync('live'))}`,1],
 ['called private server factory',`function createApi(){return http.createServer(()=>fs.readFileSync('live'))}createApi();`,1],
])test('server registration discovery respects execution scope: '+label,async t=>{
 const findings=await audit(t,{'main.ts':`import http from'node:http';import fs from'node:fs';${body}`});
 assert.equal(findings.length,1);assert.equal(high(findings).length,expected);
});

test('module initialization remains startup I/O while the request callback stays high',async t=>{
 const findings=await audit(t,{'api.ts':`import http from'node:http';import fs from'node:fs';fs.readFileSync('config');http.createServer(()=>fs.readFileSync('live')).listen(3000);`});
 assert.equal(findings.filter(f=>f.severity==='low').length,1);assert.equal(high(findings).length,1);
});

test('a CLI-only helper remains informational',async t=>{
 const findings=await audit(t,{'cli.ts':`#!/usr/bin/env node\nimport{read}from'./store.js';read();`,'store.ts':`import fs from'node:fs';export function read(){return fs.readFileSync('config')}`});
 assert.equal(findings.length,1);assert.equal(findings[0].severity,'info');
});

test('an unresolved handler wrapper cannot turn shared callback work into proven CLI-only code',async t=>{
 const findings=await audit(t,{
  'cli.ts':`#!/usr/bin/env node\nimport{read}from'./store.js';read();`,
  'api.ts':`import wrap from'external';import{read}from'./store.js';app.get('/data',wrap(read));`,
  'store.ts':`import fs from'node:fs';export function read(){return fs.readFileSync('live')}`,
 });
 assert.equal(findings.length,1);assert.notEqual(findings[0].severity,'info');
});

test('report review warning stays aligned with actual request-path severities',async t=>{
 const report=await audit(t,{
  'package.json':'{"type":"module"}',
  'api.ts':`import http from'node:http';import fs from'node:fs';function live(){return fs.readFileSync('live')}function unused(){return fs.writeFileSync('offline','x')}http.createServer(()=>live()).listen(3000);`,
 },true);
 assert.equal(report.complete,true,JSON.stringify(report.detectors));
 assert.equal(high(report.findings.filter(f=>f.id==='sync-io')).length,1);
 const interpretation=report.scoreInterpretation;
 assert.ok(interpretation);
 const priority=report.findings.filter(f=>f.severity==='critical'||f.severity==='high').length;
 assert.ok(priority>0);assert.equal(interpretation.highPriorityFindings,priority);
 assert.equal(interpretation.bySeverity.high,report.findings.filter(f=>f.severity==='high').length);
 assert.ok(renderMarkdown(report).includes(interpretation.reviewMessage));
 assert.ok(renderHtml(report).includes(interpretation.reviewMessage));
 assert.match(interpretation.meaning,/capacity|production/i);
});
