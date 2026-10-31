import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';
async function check(t,body){const root=await mkdtemp('/tmp/scale-native-callback-final-');t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(root+'/main.ts',`import http from'node:http';import fs from'node:fs';${body}`);return(await detectSyncIo(root)).filter(row=>row.message.includes('readFileSync'));}
const high=rows=>rows.filter(row=>row.severity==='high');
for(const body of [
 `http.createServer((req,res,third=fs.readFileSync('live'))=>{});`,
 `http.createServer(()=>[undefined].map((x=fs.readFileSync('live'))=>x));`,
 `http.createServer(()=>Promise.resolve().then((x=fs.readFileSync('live'))=>x));`,
 `http.createServer(()=>Promise.reject(undefined).catch((x=fs.readFileSync('live'))=>x));`,
 `http.createServer(()=>[null].map((x=fs.readFileSync('dead'))=>x));`,
])test('native callback payload defaults: '+body,async t=>{
 assert.equal(high(await check(t,body)).length,body.includes('[null]')?0:1);
});
for(const expression of [
 `[].map(read)`,`[].forEach(read)`,`Array.from([],read)`,`[].reduce(read,0)`,`[1].reduce(read)`,`[1].sort(read)`,
 `Promise.resolve().catch(read)`,`Promise.resolve(1).then(()=>{},read)`,`Promise.reject(1).then(read)`,
])test('known non-executed callback stays out of request evidence: '+expression,async t=>{
 assert.equal(high(await check(t,`function read(){fs.readFileSync('dead')}http.createServer(()=>${expression});`)).length,0);
});
for(const mutation of [`fs.readdirSync=()=>({map(){}})`,`Object.assign(fs,{readdirSync(){return{map(){}}}})`])test('mutated filesystem function does not certify array callbacks: '+mutation,async t=>{
 assert.equal(high(await check(t,`${mutation};function read(){fs.readFileSync('dead')}http.createServer(()=>fs.readdirSync('x').map(read));`)).length,0);
});
for(const expression of [`[1].map(function(){this.read()},service)`,`[1].forEach(function(){this.read()},service)`,`Array.from([1],function(){this.read()},service)`])test('native callback preserves thisArg: '+expression,async t=>{
 assert.equal(high(await check(t,`const service={read(){fs.readFileSync('live')}};http.createServer(()=>${expression});`)).length,1);
});
test('native Promise executor executes synchronously',async t=>{
 assert.equal(high(await check(t,`http.createServer(()=>new Promise(resolve=>{fs.readFileSync('live');resolve()}));`)).length,1);
});
test('Array.from mapping callback is request work',async t=>{
 assert.equal(high(await check(t,`function read(){fs.readFileSync('live')}http.createServer(()=>Array.from([1],read));`)).length,1);
});
test('native HTTP ignores an extra listener when its first argument is the listener',async t=>{
 assert.equal(high(await check(t,`http.createServer(()=>{},()=>fs.readFileSync('dead'));`)).length,0);
});
test('Express supplies its next argument without executing a missing default',async t=>{
 assert.equal(high(await check(t,`app.get('/',(req,res,next=fs.readFileSync('dead'))=>{});`)).length,0);
});
test('array growth invalidates static emptiness while preserving native callback semantics',async t=>{
 assert.equal(high(await check(t,`const items=[];items.push(1);function read(){fs.readFileSync('live')}http.createServer(()=>items.map(read));`)).length,1);
});
test('an unknown array element is not an empty collection',async t=>{
 assert.equal(high(await check(t,`function read(){fs.readFileSync('live')}http.createServer(()=>[unknown].map(read));`)).length,1);
});
test('unknown thenable settlement retains rejection callback possibility',async t=>{
 assert.equal(high(await check(t,`function read(){fs.readFileSync('possible')}http.createServer(()=>Promise.resolve({then(resolve,reject){reject()}}).catch(read));`)).length,1);
});
