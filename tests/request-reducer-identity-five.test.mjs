import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';

async function high(t,body){
 const root=await mkdtemp('/tmp/scale-reducer-identity-five-');t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(root+'/main.ts',`import http from 'node:http';import fs from 'node:fs';${body}`);
 return(await detectSyncIo(root)).filter(row=>row.id==='sync-io'&&row.severity==='high');
}
for(const method of ['reduce','reduceRight'])for(const callback of ['[()=>fs.readFileSync("dead")]','[[()=>fs.readFileSync("dead")]]','[]'])test('array-valued '+method+' callback is not callable: '+callback,async t=>{
 assert.equal((await high(t,`http.createServer(()=>{[0].${method}(${callback},0);fs.writeFileSync('dead-tail','x')});`)).length,0);
});
test('an array callback is rejected before empty-array reduction returns',async t=>{
 assert.equal((await high(t,`http.createServer(()=>{[].reduce([()=>{}],0);fs.readFileSync('dead')});`)).length,0);
});
test('an immutable callback array alias retains runtime identity',async t=>{
 assert.equal((await high(t,`const callback=[()=>fs.readFileSync('dead')];http.createServer(()=>{[0].reduce(callback,0);fs.writeFileSync('dead-tail','x')});`)).length,0);
});
test('a callback array forwarded through a helper remains non-callable',async t=>{
 assert.equal((await high(t,`function use(callback){[0].reduce(callback,0);fs.writeFileSync('dead-tail','x')}http.createServer(()=>use([()=>fs.readFileSync('dead')]));`)).length,0);
});
test('a callback array returned by a factory remains non-callable',async t=>{
 assert.equal((await high(t,`function make(){return[()=>fs.readFileSync('dead')]}http.createServer(()=>{[0].reduce(make(),0);fs.writeFileSync('dead-tail','x')});`)).length,0);
});
test('an empty callback array returned by a factory still throws',async t=>{
 assert.equal((await high(t,`function make(){return[]}http.createServer(()=>{[].reduce(make(),0);fs.readFileSync('dead')});`)).length,0);
});
test('an object property containing a callback array stays non-callable',async t=>{
 assert.equal((await high(t,`const service={callback:[()=>fs.readFileSync('dead')]};http.createServer(()=>{[0].reduce(service.callback,0);fs.writeFileSync('dead-tail','x')});`)).length,0);
});
test('an uncertain callable alternative does not donate callable identity to an array',async t=>{
 assert.equal((await high(t,`const callback=flag?()=>{}:[()=>fs.readFileSync('dead')];http.createServer(()=>[0].reduce(callback,0));`)).length,0);
});
test('a mixed callback union retains the genuine callable alternative',async t=>{
 const rows=await high(t,`const callback=flag?()=>fs.readFileSync('live'):[()=>fs.writeFileSync('dead','x')];http.createServer(()=>[0].reduce(callback,0));`);
 assert.equal(rows.length,1);assert.match(rows[0].message,/readFileSync/);
});
test('a mixed returned callback union preserves runtime alternatives',async t=>{
 const rows=await high(t,`function make(){if(flag)return()=>fs.readFileSync('live');return[()=>fs.writeFileSync('dead','x')]}http.createServer(()=>[0].reduce(make(),0));`);
 assert.equal(rows.length,1);assert.match(rows[0].message,/readFileSync/);
});
test('an ordinary returned reducer remains callable',async t=>{
 assert.equal((await high(t,`function make(){return()=>fs.readFileSync('live')}http.createServer(()=>[0].reduce(make(),0));`)).length,1);
});
test('array and function callback bindings do not share a completion result',async t=>{
 const rows=await high(t,`function use(callback){[0].reduce(callback,0);fs.readFileSync('live-tail')}function quiet(){}http.createServer(()=>{try{use([quiet])}catch{}use(quiet)});`);
 assert.equal(rows.length,1);
});
test('route-handler array lists still expose their actual callbacks',async t=>{
 assert.equal((await high(t,`import express from 'express';const app=express();app.get('/',[()=>fs.readFileSync('live')]);`)).length,1);
});
for(const method of ['reduce','reduceRight'])test('compact dense array retains '+method+' callback execution without an initial value',async t=>{
 assert.equal((await high(t,`http.createServer(()=>Array.from(Array(2)).${method}(()=>fs.readFileSync('live')));`)).length,1);
});
test('large compact dense reductions remain bounded without allocating their runtime size',async t=>{
 assert.equal((await high(t,`http.createServer(()=>Array.from(Array(1000000000)).reduce(()=>fs.readFileSync('live')));`)).length,1);
});
