import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';
async function high(t,body){
 const root=await mkdtemp('/tmp/scale-failed-initialization-');t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(root+'/main.ts',`import http from 'node:http';import fs from 'node:fs';function stop(){throw 0}${body}`);
 return(await detectSyncIo(root)).filter(row=>row.id==='sync-io'&&row.severity==='high');
}
for(const first of [
 `(async()=>{await 0;second;fs.readFileSync('dead')})()`,
 `Promise.resolve(1).then(()=>{second;fs.readFileSync('dead')})`,
 `Promise.reject(0).catch(()=>{second;fs.readFileSync('dead')})`,
 `Promise.resolve(1).finally(()=>{second;fs.readFileSync('dead')})`
])test('failed parameter initialization preserves deferred TDZ: '+first,async t=>{
 assert.equal((await high(t,`function read(first=${first},second=stop()){}http.createServer(()=>read());`)).length,0);
});
for(const keyword of ['function','async function','function*','async function*'])test(keyword+' retains failed initialization after await',async t=>{
 assert.equal((await high(t,`${keyword} read(first=(async()=>{await 0;second;fs.readFileSync('dead')})(),second=stop()){}http.createServer(()=>read());`)).length,0);
});
for(const first of [`(async()=>{await 0;second;fs.readFileSync('live')})()`,`Promise.resolve(1).then(()=>{second;fs.readFileSync('live')})`])test('successful initialization permits deferred work: '+first,async t=>{
 assert.equal((await high(t,`function read(first=${first},second=1){}http.createServer(()=>read());`)).length,1);
});
test('provided later arguments finish initialization without evaluating their throwing default',async t=>{
 assert.equal((await high(t,`function read(first=(async()=>{await 0;second;fs.readFileSync('live')})(),second=stop()){}http.createServer(()=>read(undefined,1));`)).length,1);
});
test('earlier initialized bindings remain usable after a later default fails',async t=>{
 assert.equal((await high(t,`function read(first=1,second=(async()=>{await 0;first;fs.readFileSync('live')})(),third=stop()){}http.createServer(()=>read());`)).length,1);
});
test('a failed nested destructuring initializer leaves later bindings in TDZ',async t=>{
 assert.equal((await high(t,`function read(first=Promise.resolve(1).then(()=>{third;fs.readFileSync('dead')}),{second=stop(),third=1}={}){}http.createServer(()=>read());`)).length,0);
});
test('a possibly completed later initializer retains feasible deferred work',async t=>{
 assert.equal((await high(t,`function maybe(){if(flag)throw 0;return 1}function read(first=(async()=>{await 0;second;fs.readFileSync('live')})(),second=maybe()){}http.createServer(()=>read());`)).length,1);
});
test('deferred helper callbacks retain failed lexical initialization',async t=>{
 assert.equal((await high(t,`function schedule(fn){Promise.resolve(1).then(fn)}function read(first=schedule(()=>{second;fs.readFileSync('dead')}),second=stop()){}http.createServer(()=>read());`)).length,0);
});
for(const skip of ['if(0)await 0','while(0)await 0','for(;0;)await 0','0&&await 0','1||await 0','if("")await 0'])test('statically skipped suspension preserves immediate TDZ: '+skip,async t=>{
 assert.equal((await high(t,`function read(first=(async()=>{${skip};second;fs.readFileSync('dead')})(),second=1){}http.createServer(()=>read());`)).length,0);
});
test('a throwing await operand prevents subsequent deferred work',async t=>{
 assert.equal((await high(t,`function read(first=(async()=>{await stop();second;fs.readFileSync('dead')})(),second=1){}http.createServer(()=>read());`)).length,0);
});
test('work before a throwing await operand remains reachable',async t=>{
 const rows=await high(t,`function read(first=(async()=>{await (fs.readFileSync('live'),stop());fs.writeFileSync('dead','x')})(),second=1){}http.createServer(()=>read());`);
 assert.equal(rows.length,1);assert.match(rows[0].message,/readFileSync/);
});
test('failed and successful invocations do not share deferred completion',async t=>{
 assert.equal((await high(t,`function read(first=(async()=>{await 0;second;fs.readFileSync('live')})(),second=stop()){}http.createServer(()=>{try{read()}catch{}read(undefined,1)});`)).length,1);
});
