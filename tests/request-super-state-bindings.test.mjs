import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';

async function high(t,body){
 const root=await mkdtemp('/tmp/scale-super-state-');t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(root+'/main.ts',`import http from'node:http';import fs from'node:fs';${body}`);
 return(await detectSyncIo(root)).filter(row=>row.id==='sync-io'&&row.severity==='high');
}
for(const declaration of ['constructor(value=super()){}','constructor(value={instance:super()}){}','constructor(value=[super()]){}','constructor(run=()=>super()){run()}'])test('executed constructor default supplies initialized this: '+declaration,async t=>{
 assert.equal((await high(t,`class Base{}class Child extends Base{${declaration}}http.createServer(()=>{new Child();fs.readFileSync('live')});`)).length,1);
});
test('provided argument skips a super default and leaves construction invalid',async t=>{
 assert.equal((await high(t,`class Base{}class Child extends Base{constructor(value=super()){}}http.createServer(()=>{new Child(1);fs.readFileSync('dead')});`)).length,0);
});
test('default super also supplies the inherited replacement object',async t=>{
 assert.equal((await high(t,`class Base{constructor(){return{read(){fs.readFileSync('live')}}}}class Child extends Base{constructor(value=super()){this.read()}}http.createServer(()=>new Child());`)).length,1);
});
for(const statement of ['if(flag){super();throw 0}','if(flag){super();throw 0}else{throw 1}','if(flag)return;super();throw 0'])test('throwing initialized branch cannot validate an uninitialized exit: '+statement,async t=>{
 assert.equal((await high(t,`class Base{}class Child extends Base{constructor(flag){${statement}}}http.createServer(()=>{new Child(unknown);fs.readFileSync('dead')});`)).length,0);
});
test('an initialized nonthrowing branch preserves genuine later request work',async t=>{
 assert.equal((await high(t,`class Base{}class Child extends Base{constructor(flag){if(flag)super();else throw 0}}http.createServer(()=>{new Child(unknown);fs.readFileSync('live')});`)).length,1);
});
test('a valid object return requires no initialized this',async t=>{
 assert.equal((await high(t,`class Base{}class Child extends Base{constructor(flag){if(flag)return{};throw 0}}http.createServer(()=>{new Child(unknown);fs.readFileSync('live')});`)).length,1);
});
test('caught initialized throw can complete while its uninitialized sibling still fails',async t=>{
 assert.equal((await high(t,`class Base{}class Child extends Base{constructor(flag){try{if(flag){super();throw 0}}catch{}}}http.createServer(()=>{new Child(unknown);fs.readFileSync('live')});`)).length,1);
});
test('finally throwing prevents every otherwise initialized exit',async t=>{
 assert.equal((await high(t,`class Base{}class Child extends Base{constructor(flag){try{if(flag)super()}finally{throw 0}}}http.createServer(()=>{new Child(unknown);fs.readFileSync('dead')});`)).length,0);
});
for(const live of [false,true])test('derived arrow field attaches to the actual replacement receiver: '+live,async t=>{
 assert.equal((await high(t,`class Base{constructor(){return{read(){${live?"fs.readFileSync('live')":''}}}}}class Child extends Base{read(){fs.readFileSync('dead')}field=()=>this.read();constructor(){super();this.field()}}http.createServer(()=>new Child());`)).length,live?1:0);
});
test('later method invocation sees an initialized derived arrow field',async t=>{
 assert.equal((await high(t,`class Base{constructor(){return{read(){fs.readFileSync('live')}}}}class Child extends Base{field=()=>this.read()}http.createServer(()=>new Child().field());`)).length,1);
});
test('initialized field overrides a property returned by the base constructor',async t=>{
 assert.equal((await high(t,`class Base{constructor(){return{field(){fs.readFileSync('dead')}}}}class Child extends Base{field=()=>{}}http.createServer(()=>new Child().field());`)).length,0);
});
test('an explicit replacement return bypasses fields initialized on the former receiver',async t=>{
 assert.equal((await high(t,`class Base{}class Child extends Base{field=()=>fs.readFileSync('dead');constructor(){return{field(){}}}}http.createServer(()=>new Child().field());`)).length,0);
});
test('an extracted arrow field retains the replacement this binding',async t=>{
 assert.equal((await high(t,`class Base{constructor(){return{read(){fs.readFileSync('live')}}}}class Child extends Base{field=()=>this.read()}const instance=new Child();const handler=instance.field;http.createServer(()=>handler());`)).length,1);
});
test('class prototype methods do not leak onto the returned object',async t=>{
 assert.equal((await high(t,`class Base{constructor(){return{}}}class Child extends Base{field=()=>this.read();read(){fs.readFileSync('dead')}}http.createServer(()=>new Child().field());`)).length,0);
});
