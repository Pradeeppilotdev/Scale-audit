import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';
async function high(t,body){const root=await mkdtemp('/tmp/scale-rest-tdz-');t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(root+'/main.ts',`import http from 'node:http';import fs from 'node:fs';${body}`);return(await detectSyncIo(root)).filter(row=>row.id==='sync-io'&&row.severity==='high');}
for(const keyword of ['function','function*','async function*']){
 for(const [parameters,args,expected]of [
  ['...[value=fs.readFileSync("live")]','',1],
  ['...[value=fs.readFileSync("dead")]','1',0],
  ['...[first,second=fs.readFileSync("live")]','1',1],
  ['first,...[value=fs.readFileSync("live")]','1',1],
  ['...[{value=fs.readFileSync("live")}={}]','',1],
  ['...{0:value=fs.readFileSync("live")}','',1],
 ])test(keyword+' rest binding defaults: '+parameters+' '+args,async t=>{assert.equal((await high(t,`${keyword} read(${parameters}){}http.createServer(()=>read(${args}));`)).length,expected);});
}
test('an empty destructured rest array does not invalidate normal completion',async t=>{assert.equal((await high(t,`function read(...[value]){}http.createServer(()=>{read();fs.readFileSync('live')});`)).length,1);});
test('an ordinary rest identifier retains its actual array',async t=>{assert.equal((await high(t,`function read(...values){values.forEach(()=>fs.readFileSync('live'))}http.createServer(()=>read(1));`)).length,1);});
for(const keyword of ['function','function*','async function*'])for(const parameters of ['{first=second,second=fs.readFileSync("dead")}={}','{first=first,second=fs.readFileSync("dead")}={}','{first=second}={},second=fs.readFileSync("dead")','first=second,second=fs.readFileSync("dead")'])test(keyword+' stops later defaults after an uninitialized binding: '+parameters,async t=>{assert.equal((await high(t,`${keyword} read(${parameters}){}http.createServer(()=>read());`)).length,0);});
test('provided later arguments are still uninitialized during an earlier default',async t=>{assert.equal((await high(t,`function read(first=second,second){fs.readFileSync('dead')}http.createServer(()=>read(undefined,1));`)).length,0);});
test('work before a TDZ failure remains reachable but later default work does not',async t=>{const rows=await high(t,`function* read({first=(fs.readFileSync('live'),second,fs.writeFileSync('dead','x')),second=0}={}){}http.createServer(()=>read());`);assert.equal(rows.length,1);assert.match(rows[0].message,/readFileSync/);});
test('immediately invoked helpers see uninitialized enclosing parameters',async t=>{assert.equal((await high(t,`function read(first=(()=>{second;fs.readFileSync('dead')})(),second=1){}http.createServer(()=>read());`)).length,0);});
test('deferred closures observe parameters after initialization completes',async t=>{assert.equal((await high(t,`function read(first=()=>second(),second=()=>fs.readFileSync('live')){first()}http.createServer(()=>read());`)).length,1);});
test('earlier initialized destructured values are usable by later defaults',async t=>{assert.equal((await high(t,`function* read({first=1,second=first&&fs.readFileSync('live')}={}){}http.createServer(()=>read());`)).length,1);});
test('shadowed local bindings do not inherit an outer TDZ',async t=>{assert.equal((await high(t,`function read(first=(()=>{const second=1;fs.readFileSync('live');return second})(),second=1){}http.createServer(()=>read());`)).length,1);});

for(const property of ['length','value'])test('rest object property '+property,async t=>{assert.equal((await high(t,`function* read(...{${property}=fs.readFileSync('default')}){}http.createServer(()=>read());`)).length,property==='length'?0:1);});
test('async default work after suspension observes later initialization conservatively',async t=>{assert.equal((await high(t,`function read(first=(async()=>{await 0;second;fs.readFileSync('live')})(),second=1){}http.createServer(()=>read());`)).length,1);});
test('async default work before suspension stops at a TDZ rejection',async t=>{assert.equal((await high(t,`function read(first=(async()=>{second;fs.readFileSync('dead');await 0})(),second=1){}http.createServer(()=>read());`)).length,0);});
test('native promise callbacks do not freeze an enclosing parameter TDZ',async t=>{assert.equal((await high(t,`function read(first=Promise.resolve(1).then(()=>{second;fs.readFileSync('live')}),second=1){}http.createServer(()=>read());`)).length,1);});

for(const skip of ['if(false)await 0','while(false)await 0','false&&await 0'])test('a skipped await preserves synchronous TDZ failure: '+skip,async t=>{assert.equal((await high(t,`function read(first=(async()=>{${skip};second;fs.readFileSync('dead')})(),second=1){}http.createServer(()=>read());`)).length,0);});
