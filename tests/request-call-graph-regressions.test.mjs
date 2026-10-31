import test from 'node:test';
import assert from 'node:assert/strict';
import{mkdtemp,mkdir,writeFile,rm}from'node:fs/promises';
import os from'node:os';import path from'node:path';
import{detectSyncIo}from'../dist/detectors/syncIo.js';
import{runAudit}from'../dist/runner.js';
async function fixture(t,files){const root=await mkdtemp(path.join(os.tmpdir(),'scale-request-callgraph-'));t.after(()=>rm(root,{recursive:true,force:true}));for(const[name,source]of Object.entries(files)){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),source)}return root}
const main=body=>`import http from'node:http';import fs from'node:fs';${body}`;
async function check(t,body){return detectSyncIo(await fixture(t,{'main.ts':main(body)}))}
const high=rows=>rows.filter(row=>row.severity==='high');
for(const[guard,expected]of [[`if('0')`,1],[`if(((false)))`,0],[`if(0)`,0],[`if('')`,0],[`if({})`,1],[`while(false)`,0]])test('request literal guard '+guard,async t=>{
 const rows=await check(t,`http.createServer(()=>{${guard}fs.readFileSync('x')});`);assert.equal(high(rows).length,expected);
});
for(const expression of [`false&&fs.readFileSync('x')`,`true||fs.readFileSync('x')`,`null?.run(fs.readFileSync('x'))`,`null?.[fs.readFileSync('x')]`,`undefined?.(fs.readFileSync('x'))`])test('skipped request expression '+expression,async t=>{
 assert.equal(high(await check(t,`http.createServer(()=>{${expression}});`)).length,0);
});
test('optional receiver side effects still execute before a skipped tail',async t=>{
 const rows=await check(t,`http.createServer(()=>{(fs.readFileSync('receiver'),null)?.run(fs.writeFileSync('skipped','x'))});`);
 assert.equal(high(rows).length,1);assert.match(high(rows)[0].message,/readFileSync/);
});
test('request callback factory retains a captured callback binding',async t=>{
 assert.equal(high(await check(t,`function read(){fs.readFileSync('x')}function wrap(fn){return()=>fn()}http.createServer(wrap(read));`)).length,1);
});
test('a known helper that ignores a callback does not execute its body',async t=>{
 assert.equal(high(await check(t,`function read(){fs.readFileSync('x')}function ignore(fn){}http.createServer(()=>ignore(read));`)).length,0);
});
test('synchronous array callbacks retain request work',async t=>{
 assert.equal(high(await check(t,`function read(){fs.readFileSync('x')}http.createServer(()=>[1,2].map(read));`)).length,1);
});
test('an unresolved external callback consumer retains uncertain evidence',async t=>{
 const rows=await check(t,`function read(){fs.readFileSync('x')}http.createServer(()=>external(read));`);
 assert.equal(rows[0].severity,'medium');assert.match(rows[0].scaleTrigger,/could not be resolved/);
});
test('local default expressions execute only when the helper argument is missing',async t=>{
 const rows=await check(t,`function read(file=fs.readFileSync('default')){}http.createServer(()=>read('provided'));`);assert.equal(high(rows).length,0);
 const missing=await check(t,`function read(file=fs.readFileSync('default')){}http.createServer(()=>read());`);assert.equal(high(missing).length,1);
});
test('inspectable request recursion terminates without losing I/O',async t=>{
 assert.equal(high(await check(t,`function read(n){if(n)read(n-1);fs.readFileSync('x')}http.createServer(()=>read(2));`)).length,1);
});
test('self-referential factory aliases do not overflow the native stack',async t=>{
 const rows=await check(t,`const serve=serve;serve(()=>fs.readFileSync('x'));`);assert.equal(high(rows).length,0);
});
test('request graph exhaustion remains a strict incomplete detector result',async t=>{
 const root=await fixture(t,{'main.ts':main(`function visit(cb){visit(()=>cb());fs.readFileSync('x')}http.createServer(()=>visit(()=>{}));`)});
 const report=await runAudit(root);assert.equal(report.complete,false);assert.ok(report.detectors.some(detector=>detector.name==='detectSyncIo'&&detector.status==='failed'&&/Request reachability analysis work budget exceeded/.test(detector.reason)));
});
test('repeated service registrations share the same imported request helper body',async t=>{
 const files={'shared.ts':`import fs from'node:fs';export function read(){fs.readFileSync('x')}`};
 for(let index=0;index<100;index++)files[`server${index}.ts`]=`import http from'node:http';import{read}from'./shared.js';http.createServer(()=>read());`;
 const rows=await detectSyncIo(await fixture(t,files));assert.equal(high(rows).length,1);
});
test('a non-HTTP event emitter does not prove request callback execution',async t=>{
 const rows=await check(t,`import{EventEmitter}from'node:events';const bus=new EventEmitter();bus.on('request',()=>fs.readFileSync('x'));`);assert.equal(high(rows).length,0);
});
test('HTTP supplies request arguments without evaluating missing-argument defaults',async t=>{
 const rows=await check(t,`http.createServer((req=fs.readFileSync('default'),res)=>{});`);assert.equal(high(rows).length,0);
});
test('a literal CommonJS default callback retains cross-file request execution',async t=>{
 const root=await fixture(t,{'main.cjs':`const http=require('node:http');const handler=require('./handler.cjs');http.createServer(handler);`,'handler.cjs':`const fs=require('node:fs');module.exports=()=>fs.readFileSync('x');`});
 const rows=await detectSyncIo(root);assert.equal(high(rows).length,1);
});
test('a CommonJS default callback alias retains its declared function identity',async t=>{
 const root=await fixture(t,{'main.cjs':`const http=require('node:http');http.createServer(require('./handler.cjs'));`,'handler.cjs':`const fs=require('node:fs');function read(){fs.readFileSync('x')}module.exports=read;`});
 const rows=await detectSyncIo(root);assert.equal(high(rows).length,1);
});
test('an exported server factory does not manufacture new lexical owners in recursive callbacks',async t=>{
 const rows=await check(t,`export function create(){function pump(){Promise.resolve().finally(()=>pump());fs.readFileSync('x')}const handler=()=>pump();return http.createServer(handler)}`);
 assert.equal(high(rows).length,1);
});
