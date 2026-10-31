import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';

async function high(t,body){
 const root=await mkdtemp('/tmp/scale-factory-flow-eight-');t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(root+'/main.ts',`import http from 'node:http';import fs from 'node:fs';function stop(){throw 0}${body}`);
 return(await detectSyncIo(root)).filter(row=>row.id==='sync-io'&&row.severity==='high');
}
for(const factory of ['async function make(){return read}','function* make(){return read}','const make=async()=>read'])for(const registration of ['http.createServer(make())','http.createServer(make().bind(null))','http.createServer(()=>make().call(null))'])test('wrapped factory results are not callable handlers: '+factory+' '+registration,async t=>{
 assert.equal((await high(t,`function read(){fs.readFileSync('dead')}${factory};${registration};`)).length,0);
});
test('a synchronous factory still supplies its handler through native bind',async t=>{
 assert.equal((await high(t,`function read(){fs.readFileSync('live')}function make(){return read}http.createServer(make().bind(null));`)).length,1);
});
for(const statement of ['while(stop())fs.readFileSync("dead")','for(;stop();)fs.readFileSync("dead")','for(stop();true;)fs.readFileSync("dead")','for(const value=stop();true;)fs.readFileSync("dead")','switch(stop()){case 0:fs.readFileSync("dead");break;default:fs.writeFileSync("dead","x")}','for(const value of stop())fs.readFileSync("dead")','for(const key in stop())fs.readFileSync("dead")'])test('throwing control suppresses its body and following work: '+statement,async t=>{
 assert.equal((await high(t,`http.createServer(()=>{${statement};fs.readFileSync('dead-tail')});`)).length,0);
});
test('a loop initializer keeps work evaluated before its throw',async t=>{
 const rows=await high(t,`http.createServer(()=>{for(fs.readFileSync('live'),stop();true;)fs.writeFileSync('dead','x')});`);
 assert.equal(rows.length,1);assert.match(rows[0].message,/readFileSync/);
});
test('a do loop body runs before its throwing condition',async t=>{
 const rows=await high(t,`http.createServer(()=>{do{fs.readFileSync('live')}while(stop());fs.writeFileSync('dead','x')});`);
 assert.equal(rows.length,1);assert.match(rows[0].message,/readFileSync/);
});
test('a break skips a throwing do condition and permits later work',async t=>{
 assert.equal((await high(t,`http.createServer(()=>{do{break}while(stop());fs.readFileSync('live')});`)).length,1);
});
test('a definitely throwing incrementor suppresses later work after a true loop',async t=>{
 const rows=await high(t,`http.createServer(()=>{for(;true;stop()){fs.readFileSync('live')}fs.writeFileSync('dead','x')});`);
 assert.equal(rows.length,1);assert.match(rows[0].message,/readFileSync/);
});
test('a false loop guard preserves later work without evaluating its body or incrementor',async t=>{
 assert.equal((await high(t,`http.createServer(()=>{for(;false;stop())fs.writeFileSync('dead','x');fs.readFileSync('live')});`)).length,1);
});
test('a possibly completing loop guard keeps feasible body work',async t=>{
 assert.equal((await high(t,`function check(){if(flag)throw 0;return false}http.createServer(()=>{while(check()){fs.readFileSync('live');break}});`)).length,1);
});
for(const declaration of ['const first=stop(),second=fs.readFileSync("dead")','let first=stop(),second=fs.readFileSync("dead")','var first=stop(),second=fs.readFileSync("dead")'])test('declarator ordering stops after a throwing initializer: '+declaration,async t=>{
 assert.equal((await high(t,`http.createServer(()=>{${declaration};fs.readFileSync('dead-tail')});`)).length,0);
});
test('a declarator before a throwing initializer retains its evidence',async t=>{
 const rows=await high(t,`http.createServer(()=>{const first=fs.readFileSync('live'),second=stop(),third=fs.writeFileSync('dead','x')});`);
 assert.equal(rows.length,1);assert.match(rows[0].message,/readFileSync/);
});
test('ordered declarators also apply to a for initializer',async t=>{
 assert.equal((await high(t,`http.createServer(()=>{for(let first=stop(),second=fs.readFileSync('dead');true;)fs.writeFileSync('dead','x')});`)).length,0);
});
test('a possibly completing declarator preserves later initializers',async t=>{
 assert.equal((await high(t,`http.createServer(()=>{const first=flag?stop():0,second=fs.readFileSync('live')});`)).length,1);
});
test('a throwing first switch case prevents later cases and body work',async t=>{
 assert.equal((await high(t,`http.createServer(()=>{switch(0){case stop():fs.readFileSync('dead');break;default:fs.writeFileSync('dead','x')}fs.readFileSync('dead-tail')});`)).length,0);
});
test('a matched case skips later throwing case expressions while preserving fallthrough',async t=>{
 assert.equal((await high(t,`http.createServer(()=>{switch(0){case 0:case stop():fs.readFileSync('live')}});`)).length,1);
});
test('default selection evaluates subsequent case expressions before its body',async t=>{
 assert.equal((await high(t,`http.createServer(()=>{switch(0){default:fs.readFileSync('dead');case stop():break}});`)).length,0);
});
test('a possible earlier case match preserves its body before a later throwing case',async t=>{
 assert.equal((await high(t,`http.createServer(()=>{switch(unknown){case 0:fs.readFileSync('live');break;case stop():fs.writeFileSync('dead','x')}});`)).length,1);
});
