import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';

async function high(t,body){
 const root=await mkdtemp('/tmp/scale-request-expression-seven-');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(root+'/main.ts',`import http from 'node:http';import fs from 'node:fs';${body}`);
 return(await detectSyncIo(root)).filter(row=>row.id==='sync-io'&&row.severity==='high');
}
for(const expression of ['[stop()]','{value:stop()}','`value${stop()}`','[{value:[stop()]}]','{[stop()]:1}','{[stop()](){}}','[...stop()]','{...stop()}'])test('throwing value argument prevents callee execution: '+expression,async t=>{
 assert.equal((await high(t,`function stop(){throw 0}function run(value){fs.readFileSync('dead')}http.createServer(()=>run(${expression}));`)).length,0);
});
for(const expression of ['[fs.readFileSync("live"),stop(),fs.writeFileSync("dead","x")]','{first:fs.readFileSync("live"),second:stop(),third:fs.writeFileSync("dead","x")}','`first${fs.readFileSync("live")}second${stop()}third${fs.writeFileSync("dead","x")}`'])test('value children retain execution order: '+expression,async t=>{
 const rows=await high(t,`function stop(){throw 0}function run(value){fs.writeFileSync('dead-body','x')}http.createServer(()=>run(${expression}));`);
 assert.equal(rows.length,1);assert.match(rows[0].message,/readFileSync/);
});
test('defining an object method does not execute its body',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}function run(value){fs.readFileSync('live')}http.createServer(()=>run({method(){stop()}}));`)).length,1);
});
for(const statement of ['if(stop())fs.readFileSync("dead")','if(stop()){}else fs.readFileSync("dead")','stop()?fs.readFileSync("dead"):fs.writeFileSync("dead","x")','stop()&&fs.readFileSync("dead")','stop()||fs.readFileSync("dead")','stop()??fs.readFileSync("dead")'])test('throwing condition cannot establish a branch: '+statement,async t=>{
 assert.equal((await high(t,`function stop(){throw 0}http.createServer(()=>{${statement}});`)).length,0);
});
test('a possibly completing condition retains possible branch execution',async t=>{
 assert.equal((await high(t,`function stop(){if(flag)throw 0;return true}http.createServer(()=>{if(stop())fs.readFileSync('live')});`)).length,1);
});
for(const registration of ['http.createServer(make().bind(null))','const handler=make();http.createServer(handler.bind(null))','http.createServer(()=>make().call(null))','http.createServer(()=>make().bind(null)())'])test('native helper preserves factory callable identity: '+registration,async t=>{
 assert.equal((await high(t,`function read(){fs.readFileSync('live')}function make(){return read}${registration};`)).length,1);
});
test('factory helper retains an explicit receiver',async t=>{
 assert.equal((await high(t,`function read(){this.read()}function make(){return read}const service={read(){fs.readFileSync('live')}};http.createServer(()=>make().call(service));`)).length,1);
});
test('a source-defined bind method does not become Function.prototype.bind',async t=>{
 assert.equal((await high(t,`const service={bind(){return()=>{}}};http.createServer(service.bind(null));function unused(){fs.readFileSync('dead')}`)).length,0);
});
test('a replaced bind helper is not trusted after resolving its factory',async t=>{
 assert.equal((await high(t,`function read(){fs.readFileSync('dead')}read.bind=()=>()=>{};function make(){return read}http.createServer(make().bind(null));`)).length,0);
});
test('a throwing if condition also prevents later statements',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}http.createServer(()=>{if(stop()){}fs.readFileSync('dead')});`)).length,0);
});
for(const warm of[false,true])test('factory helper resolution retains '+(warm?'warm':'cold')+' depth costs',async t=>{
 const aliases=Array.from({length:40},(_,index)=>`const a${index+1}=(a${index});`).join('');
 const body=`const a0=()=>{};${aliases}function make(){return a40}function outer(){return${'('.repeat(20)}make().bind(null)${')'.repeat(20)}}http.createServer(outer());${warm?'http.createServer(make().bind(null));':''}`;
 await assert.rejects(()=>high(t,body),/Request binding resolution depth limit exceeded/);
});
test('a bound reducer keeps its underlying native helper identity',async t=>{
 assert.equal((await high(t,`const quiet={read(){}};const live={read(){fs.readFileSync('live')}};function reduce(prefix,acc,value){acc.read();return live}http.createServer(()=>[quiet,quiet].reduce(reduce.bind(null,0),quiet));`)).length,1);
});
for(const invocation of ['[1].forEach(run.bind(null))','[1].map(run.bind(null))','Array.from([1],run.bind(null))','Promise.resolve(1).then(run.bind(null))'])test('native callbacks do not poison a bound callback: '+invocation,async t=>{
 assert.equal((await high(t,`function run(){fs.readFileSync('live')}http.createServer(()=>${invocation});`)).length,1);
});
test('an unknown callback consumer still invalidates Function helpers',async t=>{
 assert.equal((await high(t,`function run(){fs.readFileSync('dead')}external(run);http.createServer(run.bind(null));`)).length,0);
});
test('mutated native callback methods do not certify bound helper identity',async t=>{
 assert.equal((await high(t,`Array.prototype.reduce=(callback)=>{callback.bind=()=>()=>{}};function run(){fs.readFileSync('dead')}[1].reduce(run);http.createServer(run.bind(null));`)).length,0);
});
