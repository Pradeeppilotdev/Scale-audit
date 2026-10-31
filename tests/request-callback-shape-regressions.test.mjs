import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';

async function findings(t,body){
 const root=await mkdtemp('/tmp/scale-request-callback-shapes-');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(root+'/main.ts',`import http from 'node:http';import fs from 'node:fs';${body}`);
 return (await detectSyncIo(root)).filter(f=>f.id==='sync-io');
}
async function high(t,body){return(await findings(t,body)).filter(f=>f.severity==='high')}
for(const[values,guard]of [['[0,1]','if(x)'],['[1,0]','if(x)return;'],['[null,1]','if(x)'],['[false,true]','if(x)']])test('callback payload union preserves a live branch: '+values+' '+guard,async t=>{
 assert.equal((await high(t,`http.createServer(()=>${values}.forEach(x=>{${guard}fs.readFileSync('live')}));`)).length,1);
});
test('all false payload alternatives exclude the true branch',async t=>{
 assert.equal((await high(t,`http.createServer(()=>[0,false,null,''].forEach(x=>{if(x)fs.readFileSync('dead')}));`)).length,0);
});
test('all true payload alternatives exclude the false branch',async t=>{
 assert.equal((await high(t,`http.createServer(()=>[1,2,'yes'].forEach(x=>{if(x)return;fs.readFileSync('dead')}));`)).length,0);
});
for(const expression of ['new Array(3).map(read)','new Array(1000000000).map(read)','[].filter(()=>true).map(read)','new Array(3).filter(()=>true).map(read)','Object.keys({}).map(read)','Object.values({}).forEach(read)','Array.from({length:0},read)','Array.from(Object.keys({}),read)','Array.from({length:0}).map(read)'])test('known empty or sparse native collection excludes callback: '+expression,async t=>{
 assert.equal((await high(t,`function read(){fs.readFileSync('dead')}http.createServer(()=>${expression});`)).length,0);
});
for(const expression of ['new Array(3).find(read)','Array.from(new Array(3),read)','new Array("value").map(read)'])test('native collections that visit values retain callback evidence: '+expression,async t=>{
 assert.equal((await high(t,`function read(){fs.readFileSync('live')}http.createServer(()=>${expression});`)).length,1);
});
test('visible array argument retains native collection provenance',async t=>{
 assert.equal((await high(t,`function each(items){items.forEach(()=>fs.readFileSync('live'))}http.createServer(()=>each([1]));`)).length,1);
});
test('visible empty array argument excludes native collection callback',async t=>{
 assert.equal((await high(t,`function each(items){items.forEach(()=>fs.readFileSync('dead'))}http.createServer(()=>each([]));`)).length,0);
});
test('visible undefined array element executes callback default',async t=>{
 assert.equal((await high(t,`function each(items){items.forEach((x=fs.readFileSync('live'))=>x)}http.createServer(()=>each([undefined]));`)).length,1);
});
test('forwarded parameter array and local alias preserve container',async t=>{
 assert.equal((await high(t,`function each(items){const copy=items;copy.forEach(()=>fs.readFileSync('live'))}function forward(items){each(items)}http.createServer(()=>forward([1]));`)).length,1);
});
test('empty array argument is supplied and does not execute parameter default',async t=>{
 assert.equal((await high(t,`function each(items=fs.readFileSync('dead')){}http.createServer(()=>each([]));`)).length,0);
});
test('an undefined element does not make the array argument itself undefined',async t=>{
 assert.equal((await high(t,`function each(items=fs.readFileSync('dead')){}http.createServer(()=>each([undefined]));`)).length,0);
});
test('empty and nonempty helper invocations retain distinct container signatures',async t=>{
 assert.equal((await high(t,`function each(items){items.forEach(()=>fs.readFileSync('live'))}http.createServer(()=>{each([]);each([1])});`)).length,1);
});
test('an empty supplied array does not hide a later missing-argument default',async t=>{
 assert.equal((await high(t,`function each(items=fs.readFileSync('live')){}http.createServer(()=>{each([]);each()});`)).length,1);
});
test('an escaped empty array no longer proves callback nonexecution',async t=>{
 const rows=await findings(t,`const items=[];external(items);function read(){fs.readFileSync('unknown')}http.createServer(()=>items.map(read));`);
 assert.equal(rows.length,1);assert.equal(rows[0].severity,'medium');assert.match(rows[0].scaleTrigger,/could not be resolved/);
});
test('unknown escape through a local alias prevents empty-array proof',async t=>{
 const rows=await findings(t,`function each(items){const copy=items;external(copy);items.map(()=>fs.readFileSync('unknown'))}http.createServer(()=>each([]));`);
 assert.equal(rows.length,1);assert.equal(rows[0].severity,'medium');assert.match(rows[0].scaleTrigger,/could not be resolved/);
});
