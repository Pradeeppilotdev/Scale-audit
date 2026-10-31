import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';
import {Workspace} from '../dist/workspace.js';
import {requestReachability} from '../dist/requestReachability.js';
import {AnalysisLimitError} from '../dist/analysisBudget.js';

async function high(t,body){
 const root=await mkdtemp('/tmp/scale-class-completion-final-');t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(root+'/main.ts',`import http from 'node:http';import fs from 'node:fs';${body}`);
 return (await detectSyncIo(root)).filter(f=>f.id==='sync-io'&&f.severity==='high');
}
for(const [declaration,call,expected]of [
 ['static read()','new Reader().read()',0],['read()','Reader.read()',0],
 ['static read()','Reader.read()',1],['read()','new Reader().read()',1]
])test('class member ownership: '+declaration+' '+call,async t=>{
 assert.equal((await high(t,`class Reader{${declaration}{fs.readFileSync('live')}}http.createServer(()=>${call});`)).length,expected);
});
test('constructor replacement prevents stale prototype method evidence',async t=>{
 assert.equal((await high(t,`class Reader{constructor(){return{read(){}}}read(){fs.readFileSync('dead')}}http.createServer(()=>new Reader().read());`)).length,0);
});
test('constructor replacement object method retains request evidence',async t=>{
 assert.equal((await high(t,`class Reader{constructor(){return{read(){fs.readFileSync('live')}}}read(){}}http.createServer(()=>new Reader().read());`)).length,1);
});
test('constructor replacement method retains its receiver',async t=>{
 assert.equal((await high(t,`class Reader{constructor(){return{read(){fs.readFileSync('live')},run(){this.read()}}}}http.createServer(()=>new Reader().run());`)).length,1);
});
test('conditional constructor return keeps the possible normal instance',async t=>{
 assert.equal((await high(t,`class Reader{constructor(){if(flag)return{read(){}}}read(){fs.readFileSync('live')}}http.createServer(()=>new Reader().read());`)).length,1);
});
test('base constructor primitive return keeps original instance',async t=>{
 assert.equal((await high(t,`class Reader{constructor(){return 0}read(){fs.readFileSync('live')}}http.createServer(()=>new Reader().read());`)).length,1);
});
test('opaque constructor return does not recover stale prototype identity',async t=>{
 assert.equal((await high(t,`class Reader{constructor(){return external()}read(){fs.readFileSync('unknown')}}http.createServer(()=>new Reader().read());`)).length,0);
});
for(const prefix of ['stop();','const value=stop();','return stop();'])test('known throwing helper excludes following handler tail: '+prefix,async t=>{
 assert.equal((await high(t,`function stop(){throw 0}http.createServer(()=>{${prefix}fs.readFileSync('dead')});`)).length,0);
});
test('known throwing super excludes following constructor tail',async t=>{
 assert.equal((await high(t,`class Base{constructor(){throw 0}}class Child extends Base{constructor(){super();fs.readFileSync('dead')}}http.createServer(()=>new Child());`)).length,0);
});
test('known nonthrowing helper preserves following handler tail',async t=>{
 assert.equal((await high(t,`function ready(){return 0}http.createServer(()=>{ready();fs.readFileSync('live')});`)).length,1);
});
test('caught throwing helper preserves later handler work',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}http.createServer(()=>{try{stop()}catch{}fs.readFileSync('live')});`)).length,1);
});
test('async rejection does not synchronously complete the handler',async t=>{
 assert.equal((await high(t,`async function stop(){throw 0}http.createServer(()=>{stop();fs.readFileSync('live')});`)).length,1);
});
test('known callee parameter guard controls throwing completion',async t=>{
 assert.equal((await high(t,`function stop(flag){if(flag)throw 0}http.createServer(()=>{stop(true);fs.readFileSync('dead')});`)).length,0);
});
test('recursive unknown completion remains conservative and bounded',async t=>{
 assert.equal((await high(t,`function visit(n){if(n)visit(n-1)}http.createServer(()=>{visit(2);fs.readFileSync('live')});`)).length,1);
});
test('static field arrow retains class factory capture identity',async t=>{
 assert.equal((await high(t,`function live(){fs.readFileSync('live')}function dead(){fs.readFileSync('dead')}function make(read){return class{static read=read;static handler=()=>this.read()}}const One=make(live),Two=make(dead);http.createServer(()=>One.handler());`)).length,1);
});
test('instance field arrow retains class factory capture',async t=>{
 assert.equal((await high(t,`function make(fn){return class{read=()=>fn()}}function read(){fs.readFileSync('live')}const Reader=make(read);http.createServer(()=>new Reader().read());`)).length,1);
});
test('implicit inherited constructor completion excludes handler tail',async t=>{
 assert.equal((await high(t,`class Base{constructor(){throw 0}}class Middle extends Base{}class Child extends Middle{}http.createServer(()=>{new Child();fs.readFileSync('dead')});`)).length,0);
});
for(const expression of ['null?.(stop())','null?.run(stop())','undefined?.[stop()]()','maybe?.run(stop())'])test('skipped optional arguments do not complete the handler: '+expression,async t=>{
 assert.equal((await high(t,`function stop(){throw 0}http.createServer(()=>{${expression};fs.readFileSync('live')});`)).length,1);
});
test('throwing optional receiver still completes the handler',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}http.createServer(()=>{(stop(),null)?.run();fs.readFileSync('dead')});`)).length,0);
});
test('a warmed request alias suffix cannot bypass binding depth exhaustion',async t=>{
 const root=await mkdtemp('/tmp/scale-request-cached-depth-');t.after(()=>rm(root,{recursive:true,force:true}));
 const aliases='const a0=()=>{};'+Array.from({length:70},(_,index)=>`const a${index+1}=a${index};`).join('');
 await writeFile(root+'/main.ts',`import http from 'node:http';${aliases}http.createServer(()=>{a60();a70()});`);
 const ws=await Workspace.load(root);
 assert.throws(()=>requestReachability(ws),error=>error instanceof AnalysisLimitError&&/binding resolution depth limit exceeded/i.test(error.message));
});
