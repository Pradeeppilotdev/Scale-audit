import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';

async function high(t,body){
 const root=await mkdtemp('/tmp/scale-constructor-seven-');t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(root+'/main.ts',`import http from 'node:http';import fs from 'node:fs';function stop(){throw 0}${body}`);
 return(await detectSyncIo(root)).filter(row=>row.id==='sync-io'&&row.severity==='high');
}
for(const body of ['const init=async()=>super();init()','const init=async()=>{super();await 0};init()','const init=async()=>{super();throw 0};init()','const init=async()=>{if(true)super();await 0};init()'])test('pre-await async super initializes the constructor: '+body,async t=>{
 assert.equal((await high(t,`class Base{}class Child extends Base{constructor(){${body}}}http.createServer(()=>{new Child();fs.readFileSync('live')});`)).length,1);
});
for(const body of ['const init=async()=>{await 0;super()};init()','const init=async()=>{throw 0;super()};init()','const init=async()=>{await super()};init()'])test('async initialization respects its synchronous prefix: '+body,async t=>{
 const expected=body.includes('await super()')?1:0;
 assert.equal((await high(t,`class Base{}class Child extends Base{constructor(){${body}}}http.createServer(()=>{new Child();fs.readFileSync('live')});`)).length,expected);
});
test('caught derived field failure retains initialized this for later request work',async t=>{
 assert.equal((await high(t,`class Base{}class Child extends Base{field=stop();constructor(){try{super()}catch{}}}http.createServer(()=>{new Child();fs.readFileSync('live')});`)).length,1);
});
test('caught derived field failure allows this method calls in the constructor',async t=>{
 assert.equal((await high(t,`class Base{}class Child extends Base{field=stop();read(){fs.readFileSync('live')}constructor(){try{super()}catch{}this.read()}}http.createServer(()=>new Child());`)).length,1);
});
test('caught base failure leaves this uninitialized',async t=>{
 assert.equal((await high(t,`class Base{constructor(){throw 0}}class Child extends Base{constructor(){try{super()}catch{}}}http.createServer(()=>{new Child();fs.readFileSync('dead')});`)).length,0);
});
for(const body of ['this.x;fs.readFileSync("dead");super()','this;fs.readFileSync("dead");super()','super();super();fs.readFileSync("dead")','const init=()=>{this.x;fs.readFileSync("dead")};init();super()'])test('constructor state failures prevent unreachable body calls: '+body,async t=>{
 assert.equal((await high(t,`class Base{}class Child extends Base{constructor(){${body}}}http.createServer(()=>new Child());`)).length,0);
});
test('caught early this failure may recover through super',async t=>{
 assert.equal((await high(t,`class Base{}class Child extends Base{constructor(){try{this.x}catch{}super();fs.readFileSync('live')}}http.createServer(()=>new Child());`)).length,1);
});
test('work before a constructor initialization failure remains request reachable',async t=>{
 assert.equal((await high(t,`class Base{}class Child extends Base{constructor(){fs.readFileSync('live');this.x;super()}}http.createServer(()=>new Child());`)).length,1);
});
test('constructor loop work remains conservatively request reachable',async t=>{
 assert.equal((await high(t,`class Base{}class Child extends Base{constructor(){super();for(const value of [1])fs.readFileSync('live')}}http.createServer(()=>new Child());`)).length,1);
});

test('caught early field failure does not install later arrow fields',async t=>{
 assert.equal((await high(t,`class Base{}class Child extends Base{first=stop();later=()=>fs.readFileSync('dead');constructor(){try{super()}catch{}this.later()}}http.createServer(()=>new Child());`)).length,0);
});
test('caught later field failure retains earlier arrow fields',async t=>{
 assert.equal((await high(t,`class Base{}class Child extends Base{early=()=>fs.readFileSync('live');later=stop();constructor(){try{super()}catch{}this.early()}}http.createServer(()=>new Child());`)).length,1);
});
test('failed derived field installation preserves an existing base property',async t=>{
 assert.equal((await high(t,`class Base{constructor(){return{later(){fs.readFileSync('live')}}}}class Child extends Base{first=stop();later=()=>{};constructor(){try{super()}catch{}this.later()}}http.createServer(()=>new Child());`)).length,1);
});
