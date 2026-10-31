import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';
import {Workspace} from '../dist/workspace.js';
import {requestReachability} from '../dist/requestReachability.js';
import {AnalysisLimitError} from '../dist/analysisBudget.js';
import {runAudit} from '../dist/runner.js';

async function fixture(t,body){
 const root=await mkdtemp('/tmp/scale-request-final-bind-');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(root+'/main.ts',`import http from 'node:http';import fs from 'node:fs';${body}`);
 return root;
}
async function high(t,body){return(await detectSyncIo(await fixture(t,body))).filter(f=>f.severity==='high')}
for(const invocation of ['http.createServer(run.bind(service))','http.createServer(()=>run.call(service))'])test('arrow this cannot be replaced by native helper: '+invocation,async t=>{
 assert.equal((await high(t,`const run=()=>this.read();const service={read(){fs.readFileSync('dead')}};${invocation};`)).length,0);
});
test('a local arrow preserves its method lexical receiver',async t=>{
 assert.equal((await high(t,`const service={read(){fs.readFileSync('live')},run(){const fn=()=>this.read();fn()}};http.createServer(()=>service.run());`)).length,1);
});
test('rebinding a local arrow preserves its original method receiver',async t=>{
 const rows=await high(t,`const other={read(){fs.writeFileSync('dead','x')}};const service={read(){fs.readFileSync('live')},run(){const fn=()=>this.read();fn.bind(other)()}};http.createServer(()=>service.run());`);
 assert.equal(rows.length,1);assert.match(rows[0].message,/readFileSync/);
});
test('nested arrows inherit the same captured receiver',async t=>{
 assert.equal((await high(t,`const service={read(){fs.readFileSync('live')},run(){(()=>{(()=>this.read())()})()}};http.createServer(()=>service.run());`)).length,1);
});
test('ordinary function call still uses the supplied receiver',async t=>{
 assert.equal((await high(t,`function run(){this.read()}const service={read(){fs.readFileSync('live')}};http.createServer(()=>run.call(service));`)).length,1);
});
test('one arrow body keeps distinct lexical receivers across helper invocations',async t=>{
 const rows=await high(t,`function run(){const fn=()=>this.read();fn()}const quiet={read(){}};const live={read(){fs.readFileSync('live')}};http.createServer(()=>{run.call(quiet);run.call(live)});`);
 assert.equal(rows.length,1);assert.match(rows[0].message,/readFileSync/);
});
test('returned arrows retain the particular factory receiver',async t=>{
 const rows=await high(t,`const factory={build(){return()=>this.read()}};const live={read(){fs.readFileSync('live')},build:factory.build};const unused={read(){fs.writeFileSync('dead','x')},build:factory.build};const first=live.build();const second=unused.build();http.createServer(()=>first());`);
 assert.equal(rows.length,1);assert.match(rows[0].message,/readFileSync/);
});
for(const registration of ['handler','()=>handler()'])test('bound arguments retain factory resolution mode: '+registration,async t=>{
 assert.equal((await high(t,`function read(){fs.readFileSync('live')}function run(fn){fn()}function make(){return read}const handler=run.bind(null,make());http.createServer(${registration});`)).length,1);
});
test('bound factory cache does not mix distinct captured callbacks',async t=>{
 const rows=await high(t,`function read(){fs.readFileSync('live')}function unused(){fs.writeFileSync('dead','x')}function make(fn){return fn}function run(fn){fn()}const handler=run.bind(null,make(read));const other=run.bind(null,make(unused));http.createServer(()=>handler());`);
 assert.equal(rows.length,1);assert.match(rows[0].message,/readFileSync/);
});
test('wide shared default-argument copies remain inside the existing work budget',async t=>{
 const width=600;
 const choice=(first,last,value)=>{if(last-first===1)return value(first);const middle=(first+last)>>1;return`(unknown?${choice(first,middle,value)}:${choice(middle,last,value)})`};
 const body=`${Array.from({length:width},(_,index)=>`function f${index}(p=0){}`).join('')}const target=${choice(0,width,index=>'f'+index)};const argument=${choice(0,width,index=>index===0?'undefined':String(index))};http.createServer(()=>target(argument));`;
 const ws=await Workspace.load(await fixture(t,body));
 assert.throws(()=>requestReachability(ws),error=>error instanceof AnalysisLimitError&&/Request reachability analysis work budget exceeded/.test(error.message));
 const report=await runAudit(ws.root);
 assert.equal(report.complete,false);
 assert.ok(report.detectors.some(detector=>detector.name==='detectSyncIo'&&detector.status==='failed'&&/Request reachability analysis work budget exceeded/.test(detector.reason)));
});
