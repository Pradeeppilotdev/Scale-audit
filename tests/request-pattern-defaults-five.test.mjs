import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';

async function high(t,body){
 const root=await mkdtemp('/tmp/scale-pattern-defaults-five-');t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(root+'/main.ts',`import http from 'node:http';import fs from 'node:fs';function stop(){throw 0}${body}`);
 return(await detectSyncIo(root)).filter(row=>row.id==='sync-io'&&row.severity==='high');
}
for(const kind of ['function','function*','async function*']){
 for(const parameters of ['{value=fs.readFileSync("live")}={}','[value=fs.readFileSync("live")]=[]','{nested:{value=fs.readFileSync("live")}={}}={}'])test(kind+' evaluates nested binding defaults: '+parameters,async t=>{
  assert.equal((await high(t,`${kind} read(${parameters}){}http.createServer(()=>read());`)).length,1);
 });
 for(const argument of ['{value:1}','{value:null}'])test(kind+' supplied values skip a binding default: '+argument,async t=>{
  assert.equal((await high(t,`${kind} read({value=fs.readFileSync('dead')}={}){}http.createServer(()=>read(${argument}));`)).length,0);
 });
 test(kind+' explicit undefined selects a binding default',async t=>{
  assert.equal((await high(t,`${kind} read({value=fs.readFileSync('live')}={}){}http.createServer(()=>read({value:undefined}));`)).length,1);
 });
 test(kind+' throwing binding default stops following handler work',async t=>{
  assert.equal((await high(t,`${kind} read({value=stop()}={}){}http.createServer(()=>{read();fs.readFileSync('dead')});`)).length,0);
 });
 for(const [parameters,argument] of [['{value=fs.readFileSync("dead")}','null'],['[value=fs.readFileSync("dead")]','null'],['{value=fs.readFileSync("dead")}','undefined'],['[value=fs.readFileSync("dead")]','{}']])test(kind+' invalid destructuring stops defaults and handler tail: '+parameters+' '+argument,async t=>{
  assert.equal((await high(t,`${kind} read(${parameters}){}http.createServer(()=>{read(${argument});fs.readFileSync('dead-tail')});`)).length,0);
 });
}
test('array binding holes select defaults at their actual positions',async t=>{
 assert.equal((await high(t,`function* read([first,second=fs.readFileSync('live')]){}http.createServer(()=>read([1,,]));`)).length,1);
});
test('compact Array lengths do not hide binding defaults beyond the representative hole',async t=>{
 assert.equal((await high(t,`function* read([first,second=fs.readFileSync('live')]){}http.createServer(()=>read(Array(2)));`)).length,1);
});
test('nested provided values do not execute nested defaults',async t=>{
 assert.equal((await high(t,`function* read({nested:{value=fs.readFileSync('dead')}={}}={}){}http.createServer(()=>read({nested:{value:1}}));`)).length,0);
});
test('earlier binding values are available to subsequent defaults',async t=>{
 assert.equal((await high(t,`function* read({first=true,second=first&&fs.readFileSync('live')}={}){}http.createServer(()=>read());`)).length,1);
});
test('a false earlier binding suppresses a later default effect',async t=>{
 assert.equal((await high(t,`function* read({first=false,second=first&&fs.readFileSync('dead')}={}){}http.createServer(()=>read());`)).length,0);
});
test('binding defaults execute in order and stop at a definite throw',async t=>{
 const rows=await high(t,`function* read({first=fs.readFileSync('live'),second=stop(),third=fs.writeFileSync('dead','x')}={}){}http.createServer(()=>read());`);
 assert.equal(rows.length,1);assert.match(rows[0].message,/readFileSync/);
});
test('computed binding keys execute before extracting their defaults',async t=>{
 const rows=await high(t,`function* read({[fs.readFileSync('live')]:value}={}){}http.createServer(()=>read());`);assert.equal(rows.length,1);
});
test('throwing computed binding keys suppress later defaults and handler work',async t=>{
 assert.equal((await high(t,`function* read({[stop()]:value=fs.readFileSync('dead')}={}){}http.createServer(()=>{read();fs.writeFileSync('dead-tail','x')});`)).length,0);
});
test('unknown object payloads do not provide definite default evidence',async t=>{
 assert.equal((await high(t,`function* read({value=fs.readFileSync('possible')}){}http.createServer(request=>read(request));`)).length,0);
});
test('inherited object members do not select destructuring defaults',async t=>{
 assert.equal((await high(t,`function* read({toString=fs.readFileSync('dead')}={}){}http.createServer(()=>read());`)).length,0);
});
test('ordinary destructured defaults bind values used by a helper body',async t=>{
 assert.equal((await high(t,`function read({run=()=>fs.readFileSync('live')}={}){run()}http.createServer(()=>read());`)).length,1);
});
test('a generator body remains deferred after a destructuring default',async t=>{
 const rows=await high(t,`function* read({value=fs.readFileSync('live')}={}){fs.writeFileSync('dead-body','x')}http.createServer(()=>read());`);
 assert.equal(rows.length,1);assert.match(rows[0].message,/readFileSync/);
});
for(const kind of ['array','object'])test('wide '+kind+' parameter bindings stay within unchanged work limits',async t=>{
 const count=1000;
 const pattern=kind==='array'?'['+Array.from({length:count},(_,i)=>`v${i}=0`).join(',')+']':'{'+Array.from({length:count},(_,i)=>`v${i}=0`).join(',')+'}';
 const argument=kind==='array'?'['+'1,'.repeat(count)+']':'{'+Array.from({length:count},(_,i)=>`v${i}:1`).join(',')+'}';
 assert.equal((await high(t,`function* read(${pattern}){}http.createServer(()=>{read(${argument});fs.readFileSync('live')});`)).length,1);
});
test('string array bindings iterate Unicode code points',async t=>{
 assert.equal((await high(t,`function* read([first,second=fs.readFileSync('live')]){}http.createServer(()=>read('😀'));`)).length,1);
});
test('a supplied second Unicode code point skips its default',async t=>{
 assert.equal((await high(t,`function* read([first,second=fs.readFileSync('dead')]){}http.createServer(()=>read('😀x'));`)).length,0);
});
test('mutated supplied objects cannot donate a stale missing property',async t=>{
 assert.equal((await high(t,`const options={value:undefined};options.value=1;function* read({value=fs.readFileSync('dead')}){}http.createServer(()=>read(options));`)).length,0);
});
test('new properties on supplied objects do not trigger stale absent-property defaults',async t=>{
 assert.equal((await high(t,`const options={};options.value=1;function* read({value=fs.readFileSync('dead')}){}http.createServer(()=>read(options));`)).length,0);
});
test('an explicit property after a spread suppresses its binding default',async t=>{
 assert.equal((await high(t,`function* read({value=fs.readFileSync('dead')}){}http.createServer(()=>read({...source,value:1}));`)).length,0);
});
