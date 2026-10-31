import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';

async function high(t,body){
 const root=await mkdtemp('/tmp/scale-request-argument-bindings-');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(root+'/main.ts',`import http from 'node:http';import fs from 'node:fs';${body}`);
 return(await detectSyncIo(root)).filter(row=>row.id==='sync-io'&&row.severity==='high');
}
test('a throwing argument prevents the callee body from executing',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}function run(value){fs.readFileSync('dead')}http.createServer(()=>run(stop()));`)).length,0);
});
test('arguments before a throw execute while later arguments and body do not',async t=>{
 const rows=await high(t,`function stop(){throw 0}function run(...values){fs.writeFileSync('dead-body','x')}http.createServer(()=>run(fs.readFileSync('live'),stop(),fs.writeFileSync('dead-argument','x')));`);
 assert.equal(rows.length,1);assert.match(rows[0].message,/readFileSync/);
});
test('a throwing constructor argument prevents its body and later arguments',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}class Reader{constructor(value){fs.readFileSync('dead')}}http.createServer(()=>new Reader(stop(),fs.writeFileSync('dead','x')));`)).length,0);
});
test('a throwing callee receiver prevents argument evaluation',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}http.createServer(()=>stop().run(fs.readFileSync('dead')));`)).length,0);
});
test('a throwing computed callee key prevents argument evaluation',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}const service={run(){fs.writeFileSync('dead-body','x')}};http.createServer(()=>service[stop()](fs.readFileSync('dead-argument')));`)).length,0);
});
test('callee side effects before a throwing argument remain reachable',async t=>{
 const rows=await high(t,`function stop(){throw 0}function run(value){fs.writeFileSync('dead','x')}http.createServer(()=>(fs.readFileSync('live'),run)(stop()));`);
 assert.equal(rows.length,1);assert.match(rows[0].message,/readFileSync/);
});
test('a throwing comma prefix prevents the later argument expression',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}function run(value){}http.createServer(()=>run((stop(),fs.readFileSync('dead'))));`)).length,0);
});
test('a throwing spread expression prevents later arguments',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}function run(...values){}http.createServer(()=>run(...stop(),fs.readFileSync('dead')));`)).length,0);
});
test('an argument that may complete retains its possible callee execution',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}function run(value){fs.readFileSync('live')}http.createServer(()=>run(flag?stop():0));`)).length,1);
});
test('a skipped optional argument does not suppress later handler work',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}http.createServer(()=>{null?.run(stop());fs.readFileSync('live')});`)).length,1);
});
test('throwing optional computed keys do not register their callee or later arguments',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}http.createServer(()=>service?.[stop()](fs.readFileSync('dead')));`)).length,0);
});
test('a throwing HTTP factory argument does not register its callback',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}http.createServer(stop(),()=>fs.readFileSync('dead'));`)).length,0);
});
test('a throwing outer argument prevents a nested HTTP registration',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}external(stop(),http.createServer(()=>fs.readFileSync('dead')));`)).length,0);
});
test('a possibly completed outer argument retains nested HTTP registration',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}external(flag?stop():0,http.createServer(()=>fs.readFileSync('live')));`)).length,1);
});
test('unrelated exported library helpers do not exhaust request completion depth',async t=>{
 const body=`function leaf(){const value=${'('.repeat(70)}0${')'.repeat(70)}}`+Array.from({length:25},(_,index)=>`function h${index}(){${index===0?'leaf':'h'+(index-1)}()}`).join('')+`export function library(){h24()}http.createServer(()=>{});`;
 assert.equal((await high(t,body)).length,0);
});
for(const call of ['[1].forEach(run,receiver)','Array.from([1],run,receiver)'])test('native callback preserves every explicit receiver: '+call,async t=>{
 assert.equal((await high(t,`function run(){this.read()}const receiver=flag?{read(){}}:{read(){fs.readFileSync('live')}};http.createServer(()=>${call});`)).length,1);
});
test('native callback receiver alternatives stay separate',async t=>{
 assert.equal((await high(t,`function run(){this.read()}const receiver=flag?{read(){fs.readFileSync('live')}}:{read(){}};http.createServer(()=>[1].forEach(run,receiver));`)).length,1);
});
test('forEach supplies its actual array to nested callback work',async t=>{
 assert.equal((await high(t,`http.createServer(()=>[1].forEach((value,index,array)=>array.forEach(()=>fs.readFileSync('live'))));`)).length,1);
});
test('a supplied callback array retains helper forwarding provenance',async t=>{
 assert.equal((await high(t,`function read(items){items.forEach(()=>fs.readFileSync('live'))}http.createServer(()=>[1].map((value,index,array)=>read(array)));`)).length,1);
});
test('reduce supplies its actual fourth array argument',async t=>{
 assert.equal((await high(t,`http.createServer(()=>[1,2].reduce((total,value,index,array)=>{array.forEach(()=>fs.readFileSync('live'));return total},0));`)).length,1);
});
test('the actual callback array prevents its default from executing',async t=>{
 assert.equal((await high(t,`http.createServer(()=>[1].forEach((value,index,array=fs.readFileSync('dead'))=>array));`)).length,0);
});
