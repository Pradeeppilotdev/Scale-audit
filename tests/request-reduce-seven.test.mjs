import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';

async function high(t,body){
 const root=await mkdtemp('/tmp/scale-reduce-seven-');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(root+'/main.ts',`import http from 'node:http';import fs from 'node:fs';const quiet={read(){}};const live={read(){fs.readFileSync('live')}};${body}`);
 return(await detectSyncIo(root)).filter(row=>row.id==='sync-io'&&row.severity==='high');
}
for(const [method,items] of [['reduce','[quiet,live]'],['reduceRight','[live,quiet]']])test(method+' seeds the accumulator with the correct edge element',async t=>{
 assert.equal((await high(t,`http.createServer(()=>${items}.${method}((acc,value)=>{acc.read();return acc}));`)).length,0);
});
for(const method of ['reduce','reduceRight'])test(method+' forwards a returned accumulator into the next callback',async t=>{
 assert.equal((await high(t,`http.createServer(()=>[quiet,quiet,quiet].${method}((acc,value)=>{acc.read();return live}));`)).length,1);
});
test('an initial accumulator is replaced by the first callback result',async t=>{
 assert.equal((await high(t,`http.createServer(()=>[quiet,quiet].reduce((acc,value)=>{acc.read();return live},quiet));`)).length,1);
});
test('a live element is not confused with the explicit accumulator',async t=>{
 assert.equal((await high(t,`http.createServer(()=>[live,live].reduce((acc,value)=>{acc.read();return acc},quiet));`)).length,0);
});
test('undefined is an explicitly supplied initial value',async t=>{
 assert.equal((await high(t,`http.createServer(()=>[quiet].reduce((acc=live,value)=>{acc.read();return quiet},undefined));`)).length,1);
});
test('a single element without an initial value never invokes its reducer',async t=>{
 assert.equal((await high(t,`http.createServer(()=>[quiet].reduce(()=>live.read()));`)).length,0);
});
test('holes are skipped when selecting the initial accumulator',async t=>{
 assert.equal((await high(t,`http.createServer(()=>[,quiet,,live].reduce((acc,value)=>{acc.read();return acc}));`)).length,0);
});
test('a throwing first callback prevents later reducer invocations',async t=>{
 assert.equal((await high(t,`http.createServer(()=>[quiet,live].reduce((acc,value)=>{value.read();throw 0},quiet));`)).length,0);
});
test('a reducer return helper retains its returned identity',async t=>{
 assert.equal((await high(t,`function next(){return live}http.createServer(()=>[quiet,quiet].reduce((acc,value)=>{acc.read();return next()},quiet));`)).length,1);
});
test('reduction supplies the actual original array in its fourth argument',async t=>{
 assert.equal((await high(t,`http.createServer(()=>[quiet,quiet].reduce((acc,value,index,array)=>{array.forEach(()=>live.read());return acc}));`)).length,1);
});
test('a fallthrough reducer result is undefined and selects the next default',async t=>{
 assert.equal((await high(t,`http.createServer(()=>[quiet,quiet].reduce((acc=live,value)=>{acc.read()},quiet));`)).length,1);
});
test('async reducer results are promises rather than their eventual returned object',async t=>{
 assert.equal((await high(t,`http.createServer(()=>[quiet,quiet].reduce(async(acc,value)=>{acc.read();return live},quiet));`)).length,0);
});
test('reduction binds the actual source index',async t=>{
 assert.equal((await high(t,`http.createServer(()=>[quiet,quiet].reduce((acc,value,index)=>{if(index){}else live.read();return acc}));`)).length,0);
});

test('a generator reducer executes parameter defaults but defers its body',async t=>{
 assert.equal((await high(t,`function* reduce(acc=fs.readFileSync('live-default'),value){live.read()}http.createServer(()=>[quiet].reduce(reduce,undefined));`)).length,1);
});
test('a throwing reducer default prevents its body and later iterations',async t=>{
 assert.equal((await high(t,`function stop(){throw 0}http.createServer(()=>[quiet,live].reduce((acc=stop(),value)=>{value.read();return acc},undefined));`)).length,0);
});
test('a reducer default evaluates its own effects before the body',async t=>{
 assert.equal((await high(t,`http.createServer(()=>[quiet].reduce((acc=live.read(),value)=>quiet,undefined));`)).length,1);
});
test('an empty known array never executes a reducer with an initial value',async t=>{
 assert.equal((await high(t,`http.createServer(()=>[].reduce(()=>live.read(),quiet));`)).length,0);
});
test('an all-holey known array never executes its reducer',async t=>{
 assert.equal((await high(t,`http.createServer(()=>[,,,].reduce(()=>live.read(),quiet));`)).length,0);
});
test('a reducer arrow can return the next object without a block',async t=>{
 assert.equal((await high(t,`http.createServer(()=>[live,quiet,quiet].reduce((acc,value)=>acc.read()||value));`)).length,1);
});
