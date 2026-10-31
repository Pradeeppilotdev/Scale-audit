import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';
import {runAudit} from '../dist/runner.js';

async function high(t,body){
 const root=await mkdtemp('/tmp/scale-reduction-completion-eight-');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(root+'/main.ts',`import http from 'node:http';import fs from 'node:fs';${body}`);
 return(await detectSyncIo(root)).filter(row=>row.id==='sync-io'&&row.severity==='high');
}
for(const method of ['reduce','reduceRight']){
 test(method+' throwing callback prevents unreachable handler tails',async t=>{
  assert.equal((await high(t,`http.createServer(()=>{[0].${method}(()=>{throw 0},0);fs.readFileSync('dead')});`)).length,0);
 });
 for(const array of ['[]','[,,,]'])test(method+' without an initial value throws on '+array,async t=>{
  assert.equal((await high(t,`http.createServer(()=>{${array}.${method}((acc,value)=>acc);fs.readFileSync('dead')});`)).length,0);
 });
 test(method+' with an initial value completes on an empty array',async t=>{
  assert.equal((await high(t,`http.createServer(()=>{[].${method}(()=>{throw 0},undefined);fs.readFileSync('live')});`)).length,1);
 });
 test(method+' retains work executed before its callback throws',async t=>{
  const rows=await high(t,`http.createServer(()=>{[0].${method}(()=>{fs.readFileSync('live');throw 0},0);fs.writeFileSync('dead','x')});`);
  assert.equal(rows.length,1);assert.match(rows[0].message,/readFileSync/);
 });
 test(method+' may-throw callbacks preserve their normal continuation',async t=>{
  assert.equal((await high(t,`http.createServer(()=>{[0].${method}(()=>{if(flag)throw 0;return 0},0);fs.readFileSync('live')});`)).length,1);
 });
}
for(const keyword of ['function*','async function*']){
 test(keyword+' reducer executes defaults without entering its body',async t=>{
  const rows=await high(t,`${keyword} reducer(acc=fs.readFileSync('live'),value){fs.writeFileSync('dead','x')}http.createServer(()=>[0].reduce(reducer,undefined));`);
  assert.equal(rows.length,1);assert.match(rows[0].message,/readFileSync/);
 });
 test(keyword+' throwing reducer default prevents the surrounding tail',async t=>{
  assert.equal((await high(t,`function stop(){throw 0}${keyword} reducer(acc=stop(),value){}http.createServer(()=>{[0].reduce(reducer,undefined);fs.readFileSync('dead')});`)).length,0);
 });
 test(keyword+' direct call executes its default immediately',async t=>{
  const rows=await high(t,`${keyword} read(value=fs.readFileSync('live')){fs.writeFileSync('dead','x')}http.createServer(()=>read());`);
  assert.equal(rows.length,1);assert.match(rows[0].message,/readFileSync/);
 });
 test(keyword+' direct throwing default prevents the surrounding tail',async t=>{
  assert.equal((await high(t,`function stop(){throw 0}${keyword} read(value=stop()){}http.createServer(()=>{read();fs.readFileSync('dead')});`)).length,0);
 });
 test(keyword+' supplied argument skips its default',async t=>{
  assert.equal((await high(t,`${keyword} read(value=fs.readFileSync('dead')){}http.createServer(()=>read(1));`)).length,0);
 });
}
test('async reducer default rejection does not throw synchronously into its caller',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}http.createServer(()=>{[0].reduce(async(acc=stop())=>0,undefined);fs.readFileSync('live')});`)).length,1);
});
test('caught native reduction failure preserves work after the catch',async t=>{
 assert.equal((await high(t,`http.createServer(()=>{try{[].reduce((acc,value)=>acc)}catch{}fs.readFileSync('live')});`)).length,1);
});
test('unknown callback completion cannot erase possible handler work',async t=>{
 assert.equal((await high(t,`http.createServer(()=>{[0].reduce(external,0);fs.readFileSync('live')});`)).length,1);
});
test('mutated Array reduce is not assumed to have native completion',async t=>{
 assert.equal((await high(t,`Array.prototype.reduce=()=>0;http.createServer(()=>{[].reduce(()=>{throw 0});fs.readFileSync('live')});`)).length,1);
});
for(const call of ['[].reduce(0,0)','[0].reduce(null)','[0].reduce({},0)','[].reduce([],0)'])test('native reduce validates its callback even when no iteration runs: '+call,async t=>{
 assert.equal((await high(t,`http.createServer(()=>{${call};fs.readFileSync('dead')});`)).length,0);
});
test('an unknown callback on an empty initialized reduction leaves possible continuation',async t=>{
 assert.equal((await high(t,`http.createServer(()=>{[].reduce(external,0);fs.readFileSync('live')});`)).length,1);
});
for(const warm of[false,true])test('native reduction completion retains '+(warm?'warm':'cold')+' depth cost',async t=>{
 const body=`function leaf(){[0].reduce(()=>{const value=${'('.repeat(70)}0${')'.repeat(70)}},0)}`+
  Array.from({length:25},(_,index)=>`function h${index}(){${index===0?'leaf':'h'+(index-1)}()}`).join('')+
  `http.createServer(()=>{${warm?'leaf();':''}h24()});`;
 await assert.rejects(()=>high(t,body),/Request binding resolution depth limit exceeded/);
});
test('recursive native reductions remain bounded conservative completion',async t=>{
 assert.equal((await high(t,`function recurse(){[0].reduce(()=>recurse(),0)}http.createServer(()=>{recurse();fs.readFileSync('live')});`)).length,1);
});

test('native reduction depth exhaustion remains an incomplete strict audit',async t=>{
 const root=await mkdtemp('/tmp/scale-reduction-depth-eight-');t.after(()=>rm(root,{recursive:true,force:true}));
 const body=`function leaf(){[0].reduce(()=>{const value=${'('.repeat(70)}0${')'.repeat(70)}},0)}`+
  Array.from({length:25},(_,index)=>`function h${index}(){${index===0?'leaf':'h'+(index-1)}()}`).join('')+
  `http.createServer(()=>{leaf();h24()});`;
 await writeFile(root+'/main.ts',`import http from 'node:http';${body}`);
 const report=await runAudit(root);
 assert.equal(report.complete,false);
 assert.ok(report.detectors.some(detector=>detector.name==='detectSyncIo'&&detector.status==='failed'&&/Request binding resolution depth limit exceeded/.test(detector.reason)));
});
test('ordinary repeated native reduction helpers complete within unchanged work limits',async t=>{
 assert.equal((await high(t,`function sum(){return[0,1].reduce((acc,value)=>acc,0)}http.createServer(()=>{${'sum();'.repeat(150)}fs.readFileSync('live')});`)).length,1);
});
test('a factory-returned throwing reducer prevents its handler tail',async t=>{
 assert.equal((await high(t,`function make(){return()=>{throw 0}}http.createServer(()=>{[0].reduce(make(),0);fs.readFileSync('dead')});`)).length,0);
});
test('async factory reducer identity does not expose its eventual returned body',async t=>{
 assert.equal((await high(t,`async function make(){return()=>fs.readFileSync('dead')}http.createServer(()=>[0].reduce(make(),0));`)).length,0);
});
test('spread reducer arguments remain conservative instead of assuming a missing initial value',async t=>{
 assert.equal((await high(t,`const args=[()=>0,0];http.createServer(()=>{[].reduce(...args);fs.readFileSync('live')});`)).length,1);
});
