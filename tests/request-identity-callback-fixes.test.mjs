import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';
async function check(t,body){const root=await mkdtemp('/tmp/scale-request-identity-');t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(root+'/main.ts',`import http from 'node:http';import fs from 'node:fs';${body}`);return detectSyncIo(root)}
const high=rows=>rows.filter(row=>row.severity==='high');
for(const assignment of ['serve=()=>{}','if(flag)serve=()=>{}','function change(){serve=()=>{}}change()'])test('reassigned HTTP factory is not its stale initializer: '+assignment,async t=>{
 const rows=await check(t,`let serve=http.createServer;${assignment};serve(()=>fs.readFileSync('dead'));`);assert.equal(high(rows).length,0);
});
test('HTTP factory alias reassigned to a real factory is retained',async t=>{
 assert.equal(high(await check(t,`let serve=()=>{};serve=http.createServer;serve(()=>fs.readFileSync('live'));`)).length,1);
});
test('reassigned HTTP namespace alias is not its stale initializer',async t=>{
 assert.equal(high(await check(t,`let transport=http;transport={createServer(){}};transport.createServer(()=>fs.readFileSync('dead'));`)).length,0);
});
for(const name of ['app','router','server','api','fastify'])test('known unrelated route object defeats conventional spelling: '+name,async t=>{
 assert.equal(high(await check(t,`const ${name}={get(key,callback){}};${name}.get('/',()=>fs.readFileSync('dead'));`)).length,0);
});
test('unresolved conventional framework route remains supported',async t=>{
 assert.equal(high(await check(t,`app.get('/',()=>fs.readFileSync('live'));`)).length,1);
});
for(const expression of ['[1].map(x=>x,read)','[1].forEach(x=>x,read)','[1].reduce((a,x)=>a,read)','Promise.resolve(1).finally(()=>{},read)'])test('non-callback arguments do not execute: '+expression,async t=>{
 assert.equal(high(await check(t,`function read(){fs.readFileSync('dead')}http.createServer(()=>${expression});`)).length,0);
});
for(const expression of ['[1].map(read)','[1].reduce(read,0)','Promise.resolve(1).then(read)','Promise.resolve(1).finally(read)','Object.keys({x:1}).forEach(read)','fs.readdirSync("fixtures").map(read)'])test('known native callback position retains request evidence: '+expression,async t=>{
 const rows=await check(t,`function read(){fs.readFileSync('live')}http.createServer(()=>${expression});`);assert.equal(high(rows).filter(row=>row.message.includes('readFileSync')).length,1);
});
test('unknown collection method has only possible callback evidence',async t=>{
 const rows=await check(t,`function read(){fs.readFileSync('unknown')}http.createServer(()=>external.map(read));`);assert.equal(high(rows).length,0);assert.match(rows[0].scaleTrigger,/could not be resolved/);
});
test('shadowed native collection factory does not prove native callback semantics',async t=>{
 const rows=await check(t,`const Promise={resolve(){return external}};function read(){fs.readFileSync('unknown')}http.createServer(()=>Promise.resolve().then(read));`);assert.equal(high(rows).length,0);
});
for(const mutation of ['items.map=()=>{}','Object.assign(items,{map(){}})','const alias=items;alias.map=()=>{}','Object.defineProperty(items,"map",{value(){}})'])test('mutated array method does not prove native callback execution: '+mutation,async t=>{
 const rows=await check(t,`const items=[1];${mutation};function read(){fs.readFileSync('unknown')}http.createServer(()=>items.map(read));`);assert.equal(high(rows).length,0);
});
for(const mutation of ['Array.prototype.map=()=>{}','Object.assign(Array.prototype,{map(){}})','const prototype=Array.prototype;prototype.map=()=>{}','Promise.prototype.then=()=>{}'])test('native collection prototype mutation defeats callback certification: '+mutation,async t=>{
 const expression=mutation.includes('Promise')?'Promise.resolve().then(read)':'[1].map(read)';
 const rows=await check(t,`${mutation};function read(){fs.readFileSync('unknown')}http.createServer(()=>${expression});`);assert.equal(high(rows).length,0);
});
for(const mutation of ['http.createServer=()=>{}','Object.assign(http,{createServer(){}})'])test('native HTTP namespace mutation defeats factory identity: '+mutation,async t=>{
 const rows=await check(t,`${mutation};http.createServer(()=>fs.readFileSync('dead'));`);assert.equal(high(rows).length,0);
});
for(const expression of ['[1].map((x=fs.readFileSync("dead"))=>x)','[1].forEach((x,index,array=fs.readFileSync("dead"))=>{})','[1].reduce((a,x,index,array=fs.readFileSync("dead"))=>a,0)','[1,2].sort((a,b=fs.readFileSync("dead"))=>0)','Promise.resolve(1).then((x=fs.readFileSync("dead"))=>x)','Promise.reject(1).catch((error=fs.readFileSync("dead"))=>{})'])test('supplied native callback arguments do not manufacture missing defaults: '+expression,async t=>{
 const rows=await check(t,`http.createServer(()=>${expression});`);assert.equal(high(rows).length,0);
});
for(const expression of ['[1].map((a,b,c,d=fs.readFileSync("live"))=>{})','[1].reduce((a,b,c,d,e=fs.readFileSync("live"))=>a,0)','[1,2].sort((a,b,c=fs.readFileSync("live"))=>0)','Promise.resolve().then((a,b=fs.readFileSync("live"))=>{})','Promise.resolve().finally((a=fs.readFileSync("live"))=>{})'])test('genuinely missing native callback arguments execute defaults: '+expression,async t=>{
 const rows=await check(t,`http.createServer(()=>${expression});`);assert.equal(high(rows).length,1);
});
test('unproven arrays from parsed JSON retain possible callback evidence',async t=>{
 const rows=await check(t,`const cfg=JSON.parse(source);function read(){fs.readFileSync('unknown')}http.createServer(()=>cfg.tokens.map(read));`);assert.equal(high(rows).length,0);assert.match(rows[0].scaleTrigger,/could not be resolved/);
});
