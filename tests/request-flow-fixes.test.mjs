import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';

async function high(t, source) {
  const root=await mkdtemp('/tmp/scale-request-flow-');
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(root+'/main.ts',`import http from 'node:http';import fs from 'node:fs';${source}`);
  return (await detectSyncIo(root)).filter(row=>row.id==='sync-io'&&row.severity==='high');
}

for (const stop of ['return;', 'throw new Error("stop");']) test('request completion skips dead tail: '+stop, async t=>{
  assert.equal((await high(t,`http.createServer(()=>{${stop}fs.readFileSync('dead')})`)).length,0);
});

test('bound helper guard skips code after its definitely taken return',async t=>{
  assert.equal((await high(t,`function read(stop){if(stop)return;fs.readFileSync('dead')}http.createServer(()=>read(true));`)).length,0);
});

test('a return on an unknown path keeps the possible normal path',async t=>{
  assert.equal((await high(t,`http.createServer(req=>{if(req.url)return;fs.readFileSync('live')});`)).length,1);
});

test('both returning branches exclude a following request statement',async t=>{
  assert.equal((await high(t,`http.createServer(req=>{if(req.url)return;else throw 0;fs.readFileSync('dead')});`)).length,0);
});

test('a block return excludes following sibling blocks',async t=>{
  assert.equal((await high(t,`http.createServer(()=>{{return;}fs.readFileSync('dead')});`)).length,0);
});

test('false factory branch does not supply an HTTP callback',async t=>{
  assert.equal((await high(t,`function make(){if(false)return()=>fs.readFileSync('dead');return()=>0}http.createServer(make());`)).length,0);
});

test('factory stops collecting callbacks after its first definite return',async t=>{
  assert.equal((await high(t,`function make(){return()=>0;return()=>fs.readFileSync('dead')}http.createServer(make());`)).length,0);
});

test('factory guard uses the particular invocation argument',async t=>{
  assert.equal((await high(t,`function make(active){if(active)return()=>fs.readFileSync('live');return()=>0}http.createServer(make(false));`)).length,0);
  assert.equal((await high(t,`function make(active){if(active)return()=>fs.readFileSync('live');return()=>0}http.createServer(make(true));`)).length,1);
});

test('finally return replaces the attempted callback identity',async t=>{
  assert.equal((await high(t,`function make(){try{return()=>fs.readFileSync('dead')}finally{return()=>0}}http.createServer(make());`)).length,0);
});

test('finally throw prevents a factory callback from escaping',async t=>{
  assert.equal((await high(t,`function make(){try{return()=>fs.readFileSync('dead')}finally{throw 0}}http.createServer(make());`)).length,0);
});

test('a non-throwing factory return does not evaluate its catch callback',async t=>{
  assert.equal((await high(t,`function make(){try{return()=>0}catch{return()=>fs.readFileSync('dead')}}http.createServer(make());`)).length,0);
});

test('a non-throwing return excludes the catch and following handler tail',async t=>{
  assert.equal((await high(t,`http.createServer(()=>{try{return;}catch{fs.readFileSync('dead')}fs.writeFileSync('dead','x')});`)).length,0);
});

test('explicit thrown values retain the executed catch path',async t=>{
  assert.equal((await high(t,`http.createServer(()=>{try{throw 0;}catch{fs.readFileSync('live')}});`)).length,1);
});

test('finally request I/O executes after a return and its dead tail stays excluded',async t=>{
  const rows=await high(t,`http.createServer(()=>{try{return;}finally{fs.readFileSync('live')}fs.writeFileSync('dead','x')});`);
  assert.equal(rows.length,1); assert.match(rows[0].message,/readFileSync/);
});

test('false for loop excludes its body but evaluates the initializer',async t=>{
  const rows=await high(t,`http.createServer(()=>{for(fs.readFileSync('live');false;){fs.writeFileSync('dead','x')}});`);
  assert.equal(rows.length,1); assert.match(rows[0].message,/readFileSync/);
});

test('break stops the current loop body without stopping the enclosing handler',async t=>{
  const rows=await high(t,`http.createServer(()=>{while(true){break;fs.writeFileSync('dead','x')}fs.readFileSync('live')});`);
  assert.equal(rows.length,1); assert.match(rows[0].message,/readFileSync/);
});

for (const loop of ['while(true){}','for(;;){}','do{return;}while(false);']) test('a loop without a normal completion excludes the handler tail: '+loop,async t=>{
  assert.equal((await high(t,`http.createServer(()=>{${loop}fs.readFileSync('dead')});`)).length,0);
});

test('a returning loop body skips its increment and do-while condition',async t=>{
  assert.equal((await high(t,`http.createServer(()=>{for(;true;fs.readFileSync('dead'))return;});`)).length,0);
  assert.equal((await high(t,`http.createServer(()=>{do{return;}while(fs.readFileSync('dead'));});`)).length,0);
});

test('switch factory returns retain the selected callback and skip dead cases',async t=>{
  assert.equal((await high(t,`function make(active){switch(active){case false:return()=>fs.readFileSync('dead');default:return()=>0}}http.createServer(make(true));`)).length,0);
  assert.equal((await high(t,`function make(active){switch(active){case false:return()=>0;default:return()=>fs.readFileSync('live')}}http.createServer(make(true));`)).length,1);
});

test('unknown switch factory guards retain possible returned callbacks',async t=>{
  assert.equal((await high(t,`function make(active){switch(active){case false:return()=>0;default:return()=>fs.readFileSync('live')}}http.createServer(make(unknown));`)).length,1);
});
