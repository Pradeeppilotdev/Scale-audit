import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';
import {Workspace} from '../dist/workspace.js';
import {ServiceContexts} from '../dist/serviceContext.js';

const setup=`app.get('/health',()=> 'ok');process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{});`;
const health=`app.get('/health',()=> 'ok');`;
const ids=new Set(['missing-health-endpoint','missing-graceful-shutdown','missing-rejection-handler']);
async function fixture(t,main,files={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-final-release-integration-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const sources={
  'package.json':'{"type":"module","dependencies":{"express":"*"}}',
  'app.ts':`import express from 'express';export const app=express();`,
  'main.ts':`import {app}from './app.js';async function work(){throw Error()}${main}`,
  ...files,
 };
 for(const[name,source]of Object.entries(sources))await writeFile(path.join(root,name),source);
 return root;
}
async function findings(t,main,files){
 const report=await runAudit(await fixture(t,main,files));
 assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.filter(finding=>ids.has(finding.id));
}
const imported=(body)=>`import {app}from './app.js';${body}`;

for(const mid of [
 `try{await import('./broken.js')}catch{}await load();${setup}`,
 `${setup}try{await import('./broken.js')}catch{}`,
 `const pending=import('./broken.js');try{await pending}catch{}await load();${setup}`,
])test('caught imported-child rejection preserves completed parent registrations: '+mid.slice(0,75),async t=>{
 assert.equal((await findings(t,`await import('./mid.js');app.listen(3000);work();`,{
  'mid.ts':imported(mid),'broken.ts':`throw Error('failed');`,
 })).length,0);
});

test('failed child cannot donate unreachable handlers while parent health setup survives',async t=>{
 const result=await findings(t,`await import('./mid.js');app.listen(3000);work();`,{
  'mid.ts':imported(`try{await import('./broken.js')}catch{}await load();${health}`),
  'broken.ts':imported(`throw Error('failed');${setup}`),
 });
 assert.deepEqual(result.map(finding=>finding.id).sort(),['missing-graceful-shutdown','missing-rejection-handler']);
});

test('a catch cannot resume a permanently pending imported child',async t=>{
 const result=await findings(t,`await import('./mid.js');app.listen(3000);work();`,{
  'mid.ts':imported(`try{await import('./pending.js')}catch{}${setup}`),
  'pending.ts':`await new Promise(()=>{});`,
 });
 assert.equal(result.length,3);
});

test('catching an importing helper cannot donate its unreachable setup after rejection',async t=>{
 const result=await findings(t,`await import('./mid.js');app.listen(3000);work();`,{
  'mid.ts':imported(`async function configure(){await import('./broken.js');${setup}}try{await configure()}catch{}`),
  'broken.ts':`throw Error('failed');`,
 });
 assert.equal(result.length,3);
});

test('setup after catching an importing helper remains valid parent evidence',async t=>{
 const result=await findings(t,`await import('./mid.js');app.listen(3000);work();`,{
  'mid.ts':imported(`async function configure(){await import('./broken.js')}try{await configure()}catch{}${setup}`),
  'broken.ts':`throw Error('failed');`,
 });
 assert.equal(result.length,0);
});

test('a successful importing helper retains its completed setup through a catch',async t=>{
 const result=await findings(t,`await import('./mid.js');app.listen(3000);work();`,{
  'mid.ts':imported(`async function configure(){await import('./clean.js');${setup}}try{await configure()}catch{}`),
  'clean.ts':`await load();`,
 });
 assert.equal(result.length,0);
});

test('a caught helper rejection retains setup installed before its failed import',async t=>{
 const result=await findings(t,`await import('./mid.js');app.listen(3000);work();`,{
  'mid.ts':imported(`async function configure(){${setup}await import('./broken.js')}try{await configure()}catch{}`),
  'broken.ts':`throw Error('failed');`,
 });
 assert.equal(result.length,0);
});

test('caught-child parent completion cannot backfill an earlier importing listener or work',async t=>{
 assert.equal((await findings(t,`app.listen(3000);work();const pending=import('./mid.js');await pending;`,{
  'mid.ts':imported(`try{await import('./broken.js')}catch{}await load();${setup}`),
  'broken.ts':`throw Error('failed');`,
 })).length,3);
});

test('completed parent setup cannot backfill its own earlier listener',async t=>{
 const result=await findings(t,`await import('./mid.js');app.listen(4000);work();`,{
  'mid.ts':imported(`app.listen(3000);try{await import('./broken.js')}catch{}await load();${setup}`),
  'broken.ts':`throw Error('failed');`,
 });
 assert.equal(result.length,2);
 assert.ok(result.every(finding=>finding.file==='mid.ts'));
 assert.deepEqual(result.map(finding=>finding.id).sort(),['missing-graceful-shutdown','missing-health-endpoint']);
});

test('prototype replacement cannot establish a stale async condition',async t=>{
 const result=await findings(t,`async function install(){await load();${setup}}class Api{async ready(){}}const api=new Api();Object.assign(Api.prototype,{ready:()=>false});await(api.ready()&&install());app.listen(3000);work();`);
 assert.equal(result.length,3);
});

test('prototype replacement cannot donate a stale synchronous setup helper',async t=>{
 const result=await findings(t,`class Setup{install(){${setup}}}const api=new Setup();Object.assign(Setup.prototype,{install(){}});api.install();app.listen(3000);work();`);
 assert.equal(result.length,3);
});

for(const prefix of ['', 'async '])test('unmodified prototype setup helper retains protection: '+(prefix||'sync'),async t=>{
 const result=await findings(t,`class Setup{${prefix}install(){${prefix?'await load();':''}${setup}}}const api=new Setup();${prefix?'await ':''}api.install();app.listen(3000);work();`);
 assert.equal(result.length,0);
});

test('cached imported completion cannot make a failed context reusable',async t=>{
 const root=await fixture(t,`await import('./mid.js');app.listen(3000);`,{
  'mid.ts':imported(`await load();${setup}`),
  'bad.ts':`const value=${'('.repeat(140)}0${')'.repeat(140)};`,
 });
 const workspace=await Workspace.load(root);
 const context=new ServiceContexts(root,workspace);
 const main=workspace.units.find(unit=>unit.rel==='main.ts').sf;
 const bad=workspace.units.find(unit=>unit.rel==='bad.ts').sf;
 const owner=context.startup(main);
 const [listener]=owner.possibleListeners;
 assert.ok([...owner.protectionCallsFor(listener)].some(call=>call.getText().includes("app.get('/health'")));
 assert.throws(()=>context.startup(bad),/Startup expression depth limit exceeded/);
 assert.throws(()=>context.startup(main),/Startup expression depth limit exceeded/);
 assert.throws(()=>context.entryContexts(),/Startup expression depth limit exceeded/);
});
