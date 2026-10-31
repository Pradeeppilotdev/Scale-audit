import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';

async function high(t,body){
 const root=await mkdtemp('/tmp/scale-constructor-phases-');t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(root+'/main.ts',`import http from 'node:http';import fs from 'node:fs';${body}`);
 return (await detectSyncIo(root)).filter(f=>f.id==='sync-io'&&f.severity==='high');
}
for(const entry of ['constructor(x=stop()){fs.readFileSync("dead-body")}','field=stop();constructor(){fs.readFileSync("dead-body")}'])test('throwing construction phase suppresses body and handler tail: '+entry,async t=>{
 assert.equal((await high(t,`function stop(){throw 0}class Reader{${entry}}http.createServer(()=>{new Reader();fs.writeFileSync('dead-tail','x')});`)).length,0);
});
test('a supplied constructor argument skips its throwing default',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}class Reader{constructor(x=stop()){fs.readFileSync('live')}}http.createServer(()=>new Reader(1));`)).length,1);
});
test('base field initializers run before a throwing default',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}class Reader{field=fs.readFileSync('live');constructor(x=stop()){}}http.createServer(()=>new Reader());`)).length,1);
});
test('throwing field prevents later fields',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}class Reader{first=stop();later=fs.readFileSync('dead')}http.createServer(()=>new Reader());`)).length,0);
});
test('earlier field still executes before a throwing field',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}class Reader{first=fs.readFileSync('live');later=stop()}http.createServer(()=>new Reader());`)).length,1);
});
for(const result of ['1','undefined'])test('invalid derived return prevents handler tail: '+result,async t=>{
 assert.equal((await high(t,`class Base{}class Reader extends Base{constructor(){return ${result}}}http.createServer(()=>{new Reader();fs.readFileSync('dead')});`)).length,0);
});
test('derived undefined return after super completes normally',async t=>{
 assert.equal((await high(t,`class Base{}class Reader extends Base{constructor(){super();return undefined}}http.createServer(()=>{new Reader();fs.readFileSync('live')});`)).length,1);
});
test('derived object return does not require super',async t=>{
 assert.equal((await high(t,`class Base{}class Reader extends Base{constructor(){return{read(){fs.readFileSync('live')}}}}http.createServer(()=>new Reader().read());`)).length,1);
});
test('implicit derived constructor retains inherited replacement identity',async t=>{
 assert.equal((await high(t,`class Base{constructor(){return{read(){}}}}class Reader extends Base{read(){fs.readFileSync('dead')}}http.createServer(()=>new Reader().read());`)).length,0);
});
test('implicit derived constructor exposes inherited replacement methods',async t=>{
 assert.equal((await high(t,`class Base{constructor(){return{read(){fs.readFileSync('live')}}}}class Middle extends Base{}class Reader extends Middle{read(){}}http.createServer(()=>new Reader().read());`)).length,1);
});
test('explicit super keeps inherited replacement identity',async t=>{
 assert.equal((await high(t,`class Base{constructor(){return{read(){fs.readFileSync('live')}}}}class Reader extends Base{constructor(){super()}read(){}}http.createServer(()=>new Reader().read());`)).length,1);
});
for(const live of [false,true])test('explicit super updates constructor this to the returned object: '+live,async t=>{
 const replacement=live?`read(){fs.readFileSync('live')}`:'read(){}';
 const prototype=live?'read(){}':`read(){fs.readFileSync('dead')}`;
 assert.equal((await high(t,`class Base{constructor(){return{${replacement}}}}class Reader extends Base{constructor(){super();this.read()}${prototype}}http.createServer(()=>new Reader());`)).length,live?1:0);
});
for(const live of [false,true])test('derived fields use the receiver initialized by super: '+live,async t=>{
 const replacement=live?`read(){fs.readFileSync('live')}`:'read(){}';
 const prototype=live?'read(){}':`read(){fs.readFileSync('dead')}`;
 assert.equal((await high(t,`class Base{constructor(){return{${replacement}}}}class Reader extends Base{field=this.read();constructor(){super()}${prototype}}http.createServer(()=>new Reader());`)).length,live?1:0);
});
test('throwing replacement receiver field blocks constructor tail',async t=>{
 assert.equal((await high(t,`class Base{constructor(){return{read(){throw 0}}}}class Reader extends Base{field=this.read();constructor(){super();fs.readFileSync('dead')}}http.createServer(()=>new Reader());`)).length,0);
});
for(const live of [false,true])test('replacement union keeps method and receiver paired: '+live,async t=>{
 const first=live?'read(){}':`read(){fs.readFileSync('dead')}`;
 const second=live?`read(){fs.readFileSync('live')}`:'read(){}';
 assert.equal((await high(t,`class Reader{constructor(){if(flag)return{run(){},${first}};return{run(){this.read()},${second}}}}http.createServer(()=>new Reader().run());`)).length,live?1:0);
});
test('extracted replacement method does not receive its former owner',async t=>{
 assert.equal((await high(t,`class Reader{constructor(){return{run(){this.read()},read(){fs.readFileSync('dead')}}}}http.createServer(()=>{const run=new Reader().run;run()});`)).length,0);
});
test('explicit call overrides a resolved property receiver',async t=>{
 assert.equal((await high(t,`const other={read(){}};class Reader{constructor(){return{run(){this.read()},read(){fs.readFileSync('dead')}}}}http.createServer(()=>new Reader().run.call(other));`)).length,0);
});
for(const wrapper of ['void stop()','!stop()','+stop()','typeof stop()'])test('wrapped throwing helper completes before following I/O: '+wrapper,async t=>{
 assert.equal((await high(t,`function stop(){throw 0}http.createServer(()=>{${wrapper};fs.readFileSync('dead')});`)).length,0);
});
test('a wrapped nonthrowing helper preserves following I/O',async t=>{
 assert.equal((await high(t,`function ready(){return 0}http.createServer(()=>{void ready();fs.readFileSync('live')});`)).length,1);
});
