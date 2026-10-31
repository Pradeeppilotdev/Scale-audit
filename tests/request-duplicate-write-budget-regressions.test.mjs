import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';
import {runAudit} from '../dist/runner.js';
async function high(t,body){const root=await mkdtemp('/tmp/scale-duplicate-write-budget-');t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(root+'/main.js',`import http from 'node:http';import fs from 'node:fs';${body}`);return(await detectSyncIo(root)).filter(row=>row.id==='sync-io'&&row.severity==='high');}
for(const stat of[false,true])for(const live of[false,true])test('duplicate '+(stat?'static':'instance')+' fields respect a later '+(live?'live':'quiet')+' assignment',async t=>{const target=stat?'Child':'service';assert.equal((await high(t,`class Child{${stat?'static ':''}x=()=>{};${stat?'static ':''}x=()=>${live?'{}':"fs.readFileSync('dead')"}}${stat?'':'const service=new Child();'}${target}.x=()=>${live?"fs.readFileSync('live')":'{}'};http.createServer(()=>${target}.x());`)).length,live?1:0);});
test('a later duplicate initializer overwrites an earlier initializer assignment',async t=>{assert.equal((await high(t,`class Child{x=()=>{};middle=(this.x=()=>fs.readFileSync('dead'));x=()=>{}}http.createServer(()=>new Child().x());`)).length,0);});
test('a later static duplicate initializer overwrites an earlier static block assignment',async t=>{assert.equal((await high(t,`class Child{static x=()=>{};static{this.x=()=>fs.readFileSync('dead')}static x=()=>{}}http.createServer(()=>Child.x());`)).length,0);});
test('a static block after duplicate initialization may replace the final field',async t=>{assert.equal((await high(t,`class Child{static x=()=>{};static x=()=>{};static{this.x=()=>fs.readFileSync('live')}}http.createServer(()=>Child.x());`)).length,1);});
test('a field call between duplicate initializers sees the intervening assignment',async t=>{assert.equal((await high(t,`class Child{x=()=>{};middle=(this.x=()=>fs.readFileSync('live'));run=this.x();x=()=>{}}http.createServer(()=>new Child());`)).length,1);});
test('an inherited duplicate field may be reassigned after construction',async t=>{assert.equal((await high(t,`class Base{x=()=>{};x=()=>{}}class Child extends Base{}const service=new Child();service.x=()=>fs.readFileSync('live');http.createServer(()=>service.x());`)).length,1);});
test('conditional duplicate-field reassignment remains uncertain',async t=>{assert.equal((await high(t,`class Child{x=()=>{};x=()=>{}}const service=new Child();if(flag)service.x=()=>fs.readFileSync('possible');http.createServer(()=>service.x());`)).length,0);});
test('writes do not cross duplicate-field instances',async t=>{assert.equal((await high(t,`class Child{x=()=>{};x=()=>{}}const first=new Child(),second=new Child();first.x=()=>fs.readFileSync('dead');http.createServer(()=>second.x());`)).length,0);});
for(const count of[2000,5000])test(count+' empty constructor callbacks reuse semantic plans within unchanged limits',async t=>{assert.equal((await high(t,`class Base{}class Child extends Base{constructor(){super();[${Array(count).fill('1').join(',')}].forEach(()=>{})}}http.createServer(()=>{new Child();fs.readFileSync('live')});`)).length,1);});
test('repeated constructor callback work remains reachable before later duplicate super',async t=>{assert.equal((await high(t,`class Base{}class Child extends Base{constructor(){[1,2].forEach(()=>{super();fs.readFileSync('live')})}}http.createServer(()=>new Child());`)).length,1);});
test('used callback indices remain distinct',async t=>{assert.equal((await high(t,`class Base{}class Child extends Base{constructor(){[1,2].forEach((value,index)=>{if(!index){super();fs.readFileSync('live')}else super()})}}http.createServer(()=>new Child());`)).length,1);});
test('rest callback arguments remain available',async t=>{assert.equal((await high(t,`class Base{}class Child extends Base{constructor(){super();[1].forEach((...values)=>values[2].forEach(()=>fs.readFileSync('live')))}}http.createServer(()=>new Child());`)).length,1);});
test('arrow lexical arguments are not replaced by native callback arguments',async t=>{assert.equal((await high(t,`class Base{}class Child extends Base{constructor(value){super();[0].forEach(()=>arguments[0]())}}http.createServer(()=>new Child(()=>fs.readFileSync('possible')));`)).length,0);});
for(const warm of[false,true])test('primitive array shortcuts preserve '+(warm?'warm':'cold')+' helper completion depth',async t=>{
 const body=`function leaf(){const value=${'('.repeat(70)}[0]${')'.repeat(70)}}`+
  Array.from({length:25},(_,index)=>`function h${index}(){${index===0?'leaf':'h'+(index-1)}()}`).join('')+
  `http.createServer(()=>{${warm?'leaf();':''}h24()});`;
 await assert.rejects(()=>high(t,body),/Request binding resolution depth limit exceeded/);
});
