import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';

async function high(t,body){
 const root=await mkdtemp('/tmp/scale-callback-field-overwrite-');t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(root+'/main.js',`import http from 'node:http';import fs from 'node:fs';${body}`);
 return(await detectSyncIo(root)).filter(row=>row.id==='sync-io'&&row.severity==='high');
}
for(const call of ['[1,2].forEach(()=>{super();fs.readFileSync("live")})','[1,2].some(()=>{super();fs.readFileSync("live");return false})','[1,2].every(()=>{super();fs.readFileSync("live");return true})','Array.from([1,2],()=>{super();fs.readFileSync("live")})','[1,2].reduce(()=>{super();fs.readFileSync("live")},0)'])test('repeated callbacks retain work before their later initialization failure: '+call,async t=>{
 assert.equal((await high(t,`class Base{}class Child extends Base{constructor(){${call}}}http.createServer(()=>new Child());`)).length,1);
});
for(const values of ['[quiet,live]','[live,quiet]'])test('callback plans retain the receiver payload of their own iteration: '+values,async t=>{
 const rows=await high(t,`const quiet={read(){}};const live={read(){fs.readFileSync('live')}};class Base{}class Child extends Base{constructor(){${values}.forEach(service=>{super();service.read()})}}http.createServer(()=>new Child());`);
 assert.equal(rows.length,values==='[live,quiet]'?1:0);
});
test('callback plans do not revive an always-unreachable statement',async t=>{
 assert.equal((await high(t,`class Base{}class Child extends Base{constructor(){[1,2].forEach(()=>{super();throw 0;fs.readFileSync('dead')})}}http.createServer(()=>new Child());`)).length,0);
});
test('successful repeated callbacks remain within the unchanged work budget',async t=>{
 assert.equal((await high(t,`class Base{}class Child extends Base{constructor(){[${Array.from({length:200},()=>0).join(',')}].forEach((value,index)=>{if(!index)super();fs.readFileSync('live')})}}http.createServer(()=>new Child());`)).length,1);
});
for(const derived of[false,true])test('last installed duplicate field replaces an earlier arrow: '+derived,async t=>{
 assert.equal((await high(t,`class Base{}class Child${derived?' extends Base':''}{x=()=>fs.readFileSync('dead');x=()=>{}}http.createServer(()=>new Child().x());`)).length,0);
});
test('a later duplicate live field is reachable',async t=>{
 assert.equal((await high(t,`class Child{x=()=>{};x=()=>fs.readFileSync('live')}http.createServer(()=>new Child().x());`)).length,1);
});
test('a call between duplicate declarations sees the earlier installed field',async t=>{
 assert.equal((await high(t,`class Child{x=()=>fs.readFileSync('live');first=this.x();x=()=>{}}http.createServer(()=>new Child());`)).length,1);
});
test('a later undefined field overwrites an earlier arrow and blocks the handler tail',async t=>{
 assert.equal((await high(t,`class Child{x=()=>fs.readFileSync('dead');x}http.createServer(()=>{new Child().x();fs.writeFileSync('dead-tail','x')});`)).length,0);
});
test('duplicate static fields use the final installed initializer',async t=>{
 assert.equal((await high(t,`class Child{static x=()=>fs.readFileSync('dead');static x=()=>{}}http.createServer(()=>Child.x());`)).length,0);
});
test('own fields shadow prototype methods regardless of textual order',async t=>{
 assert.equal((await high(t,`class Child{x=()=>fs.readFileSync('live');x(){}}http.createServer(()=>new Child().x());`)).length,1);
});
test('inherited duplicate fields use their last installed declaration',async t=>{
 assert.equal((await high(t,`class Base{x=()=>fs.readFileSync('dead');x=()=>{}}class Child extends Base{}http.createServer(()=>new Child().x());`)).length,0);
});
test('partial replacement-object field overlays select the last completed duplicate',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}class Base{constructor(){return{}}}class Child extends Base{x=()=>fs.readFileSync('dead');x=()=>{};later=stop();constructor(){try{super()}catch{}}}http.createServer(()=>new Child().x());`)).length,0);
});

test('a failed duplicate replacement field retains the earlier completed field',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}class Base{constructor(){return{x(){}}}}class Child extends Base{x=()=>fs.readFileSync('live');x=stop();constructor(){try{super()}catch{}}}http.createServer(()=>new Child().x());`)).length,1);
});
test('a failed later duplicate cannot restore the overwritten base property',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}class Base{constructor(){return{x(){fs.readFileSync('dead')}}}}class Child extends Base{x=()=>{};x=stop();constructor(){try{super()}catch{}}}http.createServer(()=>new Child().x());`)).length,0);
});
