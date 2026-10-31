import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';

async function high(t,body){
 const root=await mkdtemp('/tmp/scale-accumulator-identity-');t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(root+'/main.ts',`import http from 'node:http';import fs from 'node:fs';${body}`);
 return(await detectSyncIo(root)).filter(row=>row.id==='sync-io'&&row.severity==='high');
}
for(const method of ['reduce','reduceRight']){
 test(method+' does not call function elements inside a returned array accumulator',async t=>{
  assert.equal((await high(t,`function make(){return[()=>fs.readFileSync('dead')]}function quiet(){}http.createServer(()=>[0,0].${method}(acc=>{acc();return make()},quiet));`)).length,0);
 });
 test(method+' retains array callback work in a returned accumulator',async t=>{
  assert.equal((await high(t,`function make(){return[1]}http.createServer(()=>[0,0].${method}(acc=>{acc.forEach(()=>fs.readFileSync('live'));return make()},[]));`)).length,1);
 });
 test(method+' preserves a factory-returned initial array accumulator',async t=>{
  assert.equal((await high(t,`function make(){return[1]}http.createServer(()=>[0].${method}(acc=>{acc.forEach(()=>fs.readFileSync('live'));return acc},make()));`)).length,1);
 });
 test(method+' does not call an initial array factory payload',async t=>{
  assert.equal((await high(t,`function make(){return[()=>fs.readFileSync('dead')]}http.createServer(()=>[0].${method}(acc=>acc(),make()));`)).length,0);
 });
}
test('conditional initial accumulator arrays preserve their runtime identity',async t=>{
 assert.equal((await high(t,`function quiet(){}http.createServer(()=>[0].reduce(acc=>acc(),flag?[()=>fs.readFileSync('dead')]:quiet));`)).length,0);
});
test('a mixed accumulator union keeps genuine callable work without calling array elements',async t=>{
 const rows=await high(t,`function live(){fs.readFileSync('live')}http.createServer(()=>[0].reduce(acc=>acc(),flag?[()=>fs.writeFileSync('dead','x')]:live));`);
 assert.equal(rows.length,1);assert.match(rows[0].message,/readFileSync/);
});
test('returned nested array payloads retain both container levels',async t=>{
 assert.equal((await high(t,`function make(){return[[1]]}http.createServer(()=>[0,0].reduce(acc=>{acc.forEach(items=>items.forEach(()=>fs.readFileSync('live')));return make()},[]));`)).length,1);
});
test('a returned empty array is a supplied accumulator rather than a missing default',async t=>{
 assert.equal((await high(t,`function make(){return[]}http.createServer(()=>[0,0].reduce((acc=fs.readFileSync('dead'))=>make(),[]));`)).length,0);
});
test('a factory array accumulator can be forwarded into a helper',async t=>{
 assert.equal((await high(t,`function make(){return[1]}function visit(items){items.forEach(()=>fs.readFileSync('live'))}http.createServer(()=>[0,0].reduce(acc=>{visit(acc);return make()},[]));`)).length,1);
});
test('a reducer default can provide a factory array accumulator',async t=>{
 assert.equal((await high(t,`function make(){return[1]}http.createServer(()=>[0].reduce((acc=make())=>{acc.forEach(()=>fs.readFileSync('live'));return acc},undefined));`)).length,1);
});
test('a returned object accumulator remains an object',async t=>{
 assert.equal((await high(t,`function make(){return{read(){fs.readFileSync('live')}}}const quiet={read(){}};http.createServer(()=>[0,0].reduce(acc=>{acc.read();return make()},quiet));`)).length,1);
});
test('route handler arrays keep their callable list semantics',async t=>{
 assert.equal((await high(t,`import express from 'express';const app=express();app.get('/',[()=>fs.readFileSync('live')]);`)).length,1);
});
test('async factory results do not donate their eventual array payload',async t=>{
 assert.equal((await high(t,`async function make(){return[1]}http.createServer(()=>[0,0].reduce(acc=>{acc.forEach(()=>fs.readFileSync('dead'));return make()},[]));`)).length,0);
});
test('generator factory results do not donate returned arrays',async t=>{
 assert.equal((await high(t,`function* make(){return[1]}http.createServer(()=>[0,0].reduce(acc=>{acc.forEach(()=>fs.readFileSync('dead'));return make()},[]));`)).length,0);
});

test('calling a known returned array accumulator stops its reducer tail',async t=>{
 assert.equal((await high(t,`function make(){return[()=>{}]}function quiet(){}http.createServer(()=>[0,0].reduce(acc=>{acc();fs.readFileSync('dead');return make()},quiet));`)).length,1);
});
test('a known factory array initial accumulator stops its reducer and handler tails',async t=>{
 assert.equal((await high(t,`function make(){return[()=>fs.readFileSync('dead-element')]}http.createServer(()=>{[0].reduce(acc=>{acc();fs.writeFileSync('dead-reducer','x')},make());fs.readFileSync('dead-handler')});`)).length,0);
});
test('a class-valued accumulator throws when called rather than donating constructor work',async t=>{
 assert.equal((await high(t,`class Service{constructor(){fs.readFileSync('dead')}}http.createServer(()=>{[0].reduce(acc=>acc(),Service);fs.writeFileSync('dead-tail','x')});`)).length,0);
});
test('a default factory payload is skipped when an actual empty array is supplied',async t=>{
 assert.equal((await high(t,`function make(){return[1]}http.createServer(()=>[0].reduce((acc=make())=>acc.forEach(()=>fs.readFileSync('dead')),[]));`)).length,0);
});
test('mutated native array methods remain uncertain for factory payloads',async t=>{
 assert.equal((await high(t,`Array.prototype.forEach=()=>{};function make(){return[1]}http.createServer(()=>[0].reduce(acc=>acc.forEach(()=>fs.readFileSync('dead')),make()));`)).length,0);
});
test('different accumulator runtime alternatives do not share a completion result',async t=>{
 assert.equal((await high(t,`function make(){return[()=>fs.writeFileSync('dead','x')]}function read(){fs.readFileSync('live')}function use(acc){[0].reduce(value=>value(),acc)}http.createServer(()=>{try{use(make())}catch{}use(read)});`)).length,1);
});
test('repeated factory accumulator callbacks stay within unchanged work limits',async t=>{
 assert.equal((await high(t,`function make(){return[1]}function use(){[0].reduce(acc=>acc.forEach(()=>fs.readFileSync('live')),make())}http.createServer(()=>{${'use();'.repeat(150)}});`)).length,1);
});
