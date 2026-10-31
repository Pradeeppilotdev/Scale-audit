import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';

async function check(t,body){
 const root=await mkdtemp('/tmp/scale-request-indirect-');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(root+'/main.ts',`import http from 'node:http';import fs from 'node:fs';${body}`);
 return (await detectSyncIo(root)).filter(f=>f.severity==='high');
}
for(const invocation of ['read.call(null)','read.bind(null)()','read.bind(null).bind({})()'])test('native function helper preserves request execution: '+invocation,async t=>{
 assert.equal((await check(t,`function read(){fs.readFileSync('live')}http.createServer(()=>${invocation});`)).length,1);
});
test('bound request handler retains its captured callback argument',async t=>{
 assert.equal((await check(t,`function run(fn){fn()}function read(){fs.readFileSync('live')}http.createServer(run.bind(null,read));`)).length,1);
});
test('creating a bound callable does not execute its body',async t=>{
 assert.equal((await check(t,`function read(){fs.readFileSync('dead')}http.createServer(()=>{read.bind(null)});`)).length,0);
});
test('rebinding cannot replace the original undefined receiver',async t=>{
 assert.equal((await check(t,`function run(){this.read()}const service={read(){fs.readFileSync('dead')}};const fn=run.bind(undefined);http.createServer(()=>fn.bind(service)());`)).length,0);
});
test('call helper preserves the explicit method receiver',async t=>{
 assert.equal((await check(t,`const service={read(){fs.readFileSync('live')},run(){this.read()}};http.createServer(()=>service.run.call(service));`)).length,1);
});
test('a replaced function helper does not execute its former target',async t=>{
 assert.equal((await check(t,`function read(){fs.readFileSync('dead')}read.call=()=>{};http.createServer(()=>read.call(null));`)).length,0);
});
test('unknown mutation prevents certification of native bind',async t=>{
 assert.equal((await check(t,`function read(){fs.readFileSync('unknown')}Object.assign(read,{bind:()=>()=>{}});http.createServer(read.bind(null));`)).length,0);
});
test('request constructor body retains blocking I/O evidence',async t=>{
 assert.equal((await check(t,`class Reader{constructor(){fs.readFileSync('live')}}http.createServer(()=>new Reader());`)).length,1);
});
test('constructor callback arguments retain their invocation bindings',async t=>{
 assert.equal((await check(t,`function read(){fs.readFileSync('live')}class Reader{constructor(fn){fn()}}http.createServer(()=>new Reader(read));`)).length,1);
});
test('instance field initialization is request work',async t=>{
 assert.equal((await check(t,`class Reader{value=fs.readFileSync('live')}http.createServer(()=>new Reader());`)).length,1);
});
test('default derived constructor invokes its base constructor',async t=>{
 assert.equal((await check(t,`class Reader{constructor(){fs.readFileSync('live')}}class Child extends Reader{}http.createServer(()=>new Child());`)).length,1);
});
test('explicit super call invokes its base constructor',async t=>{
 assert.equal((await check(t,`class Reader{constructor(){fs.readFileSync('live')}}class Child extends Reader{constructor(){super()}}http.createServer(()=>new Child());`)).length,1);
});
test('constructors that are never instantiated are not request work',async t=>{
 assert.equal((await check(t,`class Reader{constructor(){fs.readFileSync('dead')}}http.createServer(()=>{});`)).length,0);
});
for(const body of ['throw 0','return {}'])test('derived fields require super execution: '+body,async t=>{
 assert.equal((await check(t,`class Base{}class Child extends Base{value=fs.readFileSync('dead');constructor(){${body}}}http.createServer(()=>new Child());`)).length,0);
});
test('derived fields execute after a completed explicit super call',async t=>{
 assert.equal((await check(t,`class Base{}class Child extends Base{value=fs.readFileSync('live');constructor(){super()}}http.createServer(()=>new Child());`)).length,1);
});
test('derived fields execute after a completed implicit super call',async t=>{
 assert.equal((await check(t,`class Base{}class Child extends Base{value=fs.readFileSync('live')}http.createServer(()=>new Child());`)).length,1);
});
for(const constructor of ['', 'constructor(){super()}'])test('a definitely throwing base prevents derived fields: '+constructor,async t=>{
 assert.equal((await check(t,`class Base{constructor(){throw 0}}class Child extends Base{value=fs.readFileSync('dead');${constructor}}http.createServer(()=>new Child());`)).length,0);
});
