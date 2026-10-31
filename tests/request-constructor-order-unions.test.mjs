import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';

async function high(t,body){
 const root=await mkdtemp('/tmp/scale-constructor-order-unions-');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(root+'/main.ts',`import http from 'node:http';import fs from 'node:fs';${body}`);
 return(await detectSyncIo(root)).filter(f=>f.id==='sync-io'&&f.severity==='high');
}
test('base fields execute before a throwing parameter default',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}class Reader{field=fs.readFileSync('live');constructor(x=stop()){}}http.createServer(()=>new Reader());`)).length,1);
});
test('throwing base field prevents parameter defaults',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}class Reader{field=stop();constructor(x=fs.readFileSync('dead')){}}http.createServer(()=>new Reader());`)).length,0);
});
test('base fields precede defaults while throwing defaults suppress constructor body and handler tail',async t=>{
 const rows=await high(t,`function stop(){throw 0}class Reader{field=fs.readFileSync('live');constructor(x=stop()){fs.writeFileSync('dead','x')}}http.createServer(()=>{new Reader();fs.appendFileSync('dead','x')});`);
 assert.equal(rows.length,1);assert.match(rows[0].message,/readFileSync/);
});
test('derived defaults still execute before super and derived fields',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}class Base{}class Reader extends Base{field=fs.readFileSync('dead');constructor(x=stop()){super()}}http.createServer(()=>new Reader());`)).length,0);
});
for(const body of ['(()=>super())()','const init=()=>super();init()','const init=()=>super();const call=init;call()'])test('executed lexical super wrapper completes construction: '+body,async t=>{
 assert.equal((await high(t,`class Base{}class Reader extends Base{constructor(){${body}}}http.createServer(()=>{new Reader();fs.readFileSync('live')});`)).length,1);
});
test('a lexical super wrapper retains helper argument bindings',async t=>{
 assert.equal((await high(t,`function read(){fs.readFileSync('live')}class Base{constructor(fn){fn()}}class Reader extends Base{constructor(){const init=fn=>super(fn);init(read)}}http.createServer(()=>new Reader());`)).length,1);
});
for(const body of ['const init=()=>super();','const init=()=>super();if(false)init();'])test('unexecuted lexical super is not construction evidence: '+body,async t=>{
 assert.equal((await high(t,`class Base{}class Reader extends Base{constructor(){${body}}}http.createServer(()=>{new Reader();fs.readFileSync('dead')});`)).length,0);
});
test('a returned undefined after invoked lexical super completes construction',async t=>{
 assert.equal((await high(t,`class Base{}class Reader extends Base{constructor(){const init=()=>super();init();return undefined}}http.createServer(()=>{new Reader();fs.readFileSync('live')});`)).length,1);
});
test('lexical super preserves inherited replacement receiver identity',async t=>{
 assert.equal((await high(t,`class Base{constructor(){return{read(){fs.readFileSync('live')}}}}class Reader extends Base{constructor(){const init=()=>super();init()}read(){}}http.createServer(()=>new Reader().read());`)).length,1);
});
for(const call of ['run.call(target)','run.bind(target)()'])test('explicit receiver union retains a later live alternative: '+call,async t=>{
 assert.equal((await high(t,`function run(){this.read()}const quiet={read(){}};const live={read(){fs.readFileSync('live')}};const target=flag?quiet:live;http.createServer(()=>${call});`)).length,1);
});
test('registered bound receiver union retains a later live alternative',async t=>{
 assert.equal((await high(t,`function run(){this.read()}const target=flag?{read(){}}:{read(){fs.readFileSync('live')}};http.createServer(run.bind(target));`)).length,1);
});
test('rebinding cannot replace any original bound receiver alternative',async t=>{
 assert.equal((await high(t,`function run(){this.read()}const target=flag?{read(){}}:{read(){fs.readFileSync('live')}};const bound=run.bind(target);const quiet={read(){}};http.createServer(bound.bind(quiet));`)).length,1);
});
test('call receiver union preserves positional arguments',async t=>{
 assert.equal((await high(t,`function run(fn){this.read(fn)}function read(){fs.readFileSync('live')}const target=flag?{read(){}}:{read(fn){fn()}};http.createServer(()=>run.call(target,read));`)).length,1);
});
test('receiver alternatives cannot replace lexical arrow this',async t=>{
 assert.equal((await high(t,`const run=()=>this.read();const target=flag?{read(){fs.readFileSync('dead')}}:{read(){}};http.createServer(run.bind(target));`)).length,0);
});
test('one nonthrowing receiver alternative keeps the following request tail',async t=>{
 assert.equal((await high(t,`function run(){this.stop()}const target=flag?{stop(){throw 0}}:{stop(){}};http.createServer(()=>{run.call(target);fs.readFileSync('live')});`)).length,1);
});
test('all throwing receiver alternatives suppress the following request tail',async t=>{
 assert.equal((await high(t,`function run(){this.stop()}const target=flag?{stop(){throw 0}}:{stop(){throw 1}};http.createServer(()=>{run.call(target);fs.readFileSync('dead')});`)).length,0);
});
