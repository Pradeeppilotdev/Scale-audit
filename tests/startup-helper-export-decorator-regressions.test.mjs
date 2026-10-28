import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';
const head=`import express from 'express';const app=express();`;
const protect=`process.on('SIGTERM',()=>{});app.get('/health',()=> 'ok');`;
async function audit(t,body,legacy=false){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-startup-helper-export-decorator-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),JSON.stringify({type:'module',dependencies:{express:'*'}}));
 if(legacy)await writeFile(path.join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{experimentalDecorators:true}}));
 await writeFile(path.join(root,'main.ts'),head+body);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.filter(f=>['missing-health-endpoint','missing-graceful-shutdown'].includes(f.id));
}
for(const body of [
 `await load();function setup(){${protect}}setup();app.listen(3000);`,
 `await load();function setup(){${protect}}app.listen(3000);setup();`,
 `await load();function inner(){${protect}}function setup(){inner()}setup();app.listen(3000);`,
 `await load();function setup(event,path){process.on(event,()=>{});app.get(path,()=> 'ok')}setup('SIGTERM','/health');app.listen(3000);`,
])test('reached synchronous helper retains startup evidence: '+body.slice(0,85),async t=>{
 assert.equal((await audit(t,body)).length,0);
});
for(const body of [
 `await load();function setup(){${protect}}if(enabled)setup();app.listen(3000);`,
 `await load();async function setup(){await load();${protect}}setup();app.listen(3000);`,
 `await load();function setup(event,path){process.on(event,()=>{});app.get(path,()=> 'ok')}setup('other','/users');app.listen(3000);`,
])test('uncertain or deferred helper cannot supply startup evidence: '+body.slice(0,85),async t=>{
 assert.equal((await audit(t,body)).length,2);
});
for(const body of [
 `async function setup(){await load();${protect}}await setup();export default app;app.listen(3000);`,
 `async function setup(){await load();${protect}return 3000}export default app.listen(await setup());`,
 `await load();function setup(){${protect}return app}export default setup();app.listen(3000);`,
])test('export assignment preserves ordered startup evidence: '+body.slice(0,85),async t=>{
 assert.equal((await audit(t,body)).length,0);
});
test('exported deferred function cannot install startup evidence',async t=>{
 assert.equal((await audit(t,`await load();export default ()=>{${protect}};app.listen(3000);`)).length,2);
});
for(const legacy of [false,true]){
 for(const body of [
  `function decorate(value){return ()=>{}}@decorate((process.on('SIGTERM',()=>{}),app.get('/health',()=> 'ok')))class Setup{}app.listen(3000);`,
  `await load();function decorate(value){return ()=>{}}@decorate((process.on('SIGTERM',()=>{}),app.get('/health',()=> 'ok')))class Setup{}app.listen(3000);`,
  `await load();function decorate(value){return ()=>{}}class Setup{@decorate((process.on('SIGTERM',()=>{}),app.get('/health',()=> 'ok')))method(){}}app.listen(3000);`,
  `await load();function decorate(){${protect}return ()=>{}}@decorate()class Setup{}app.listen(3000);`,
 ])test(`decorator expressions execute at class definition (${legacy?'legacy':'modern'}): `+body.slice(0,70),async t=>{
  assert.equal((await audit(t,body,legacy)).length,0);
 });
 test(`conditional decorator application cannot supply unconditional setup (${legacy?'legacy':'modern'})`,async t=>{
  assert.equal((await audit(t,`await load();function decorate(){return()=>{if(enabled){${protect}}}}@decorate()class Setup{}app.listen(3000);`,legacy)).length,2);
 });
}
for(const member of [
 `constructor(@decorate((process.on('SIGTERM',()=>{}),app.get('/health',()=> 'ok')))value:any){}`,
 `method(@decorate((process.on('SIGTERM',()=>{}),app.get('/health',()=> 'ok')))value:any){}`,
])test('legacy parameter decorator arguments execute without constructing instance: '+member.slice(0,65),async t=>{
 assert.equal((await audit(t,`await load();function decorate(value){return()=>{}}class Setup{${member}}app.listen(3000);`,true)).length,0);
});
test('ambient class decorator syntax cannot establish runtime setup',async t=>{
 assert.equal((await audit(t,`await load();function decorate(value){return()=>{}}@decorate((process.on('SIGTERM',()=>{}),app.get('/health',()=> 'ok')))declare class Setup{}app.listen(3000);`)).length,2);
});
