import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Workspace} from '../dist/workspace.js';
import {ServiceContexts} from '../dist/serviceContext.js';

async function workspace(t,files){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-startup-failure-cache-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),'{"type":"module"}');
 for(const [name,source]of Object.entries(files))await writeFile(path.join(root,name),source);
 return {root,ws:await Workspace.load(root)};
}
const deep=`process.on('SIGTERM',()=>{});const deep=${'('.repeat(140)}0${')'.repeat(140)};app.listen(3000);`;
function failure(operation,pattern){
 let caught;try{operation()}catch(error){caught=error}
 assert.ok(caught,'expected analysis to fail');assert.match(caught.message,pattern);return caught;
}
for(const entry of ['entries','startup'])test(`failed ${entry} scanning cannot expose a cached partial summary`,async t=>{
 const {root,ws}=await workspace(t,{'main.ts':deep});const source=ws.units[0].sf;
 const context=new ServiceContexts(root,ws);
 const error=failure(()=>entry==='entries'?context.entryContexts():context.startup(source),/Startup expression depth limit exceeded/);
 for(const retry of [()=>context.entryContexts(),()=>context.startup(source),()=>context.owners(source)]){
  assert.equal(failure(retry,/Startup expression depth limit exceeded/),error);
 }
 const fresh=new ServiceContexts(root,ws);
 failure(()=>fresh.entryContexts(),/Startup expression depth limit exceeded/);
});

test('a later source failure cannot expose earlier completed entry caches',async t=>{
 const {root,ws}=await workspace(t,{'a.ts':`app.listen(3000);`,'z.ts':deep});
 const context=new ServiceContexts(root,ws);const first=ws.units.find(unit=>unit.rel==='a.ts').sf;
 assert.equal([...context.startup(first).possibleListeners].length,1);
 const error=failure(()=>context.entryContexts(),/Startup expression depth limit exceeded/);
 assert.equal(failure(()=>context.startup(first),/Startup expression depth limit exceeded/),error);
 assert.equal(failure(()=>context.entryContexts(),/Startup expression depth limit exceeded/),error);
});

test('startup work exhaustion remains strict across context retries',async t=>{
 const source=`function configure(){${'trace();'.repeat(100)}}${'configure();'.repeat(400)}app.listen(3000);`;
 const {root,ws}=await workspace(t,{'main.ts':source});const context=new ServiceContexts(root,ws);
 const error=failure(()=>context.entryContexts(),/Service startup analysis work budget exceeded/);
 assert.equal(failure(()=>context.entryContexts(),/Service startup analysis work budget exceeded/),error);
 failure(()=>new ServiceContexts(root,ws).entryContexts(),/Service startup analysis work budget exceeded/);
});

test('lazy union exhaustion invalidates previously cached entry points',async t=>{
 const {root,ws}=await workspace(t,{'main.ts':'trace();'.repeat(100)});const context=new ServiceContexts(root,ws);
 const [owner]=context.entryContexts();let error;
 // Repeated public iteration is real work charged to the shared context. This
 // bounded loop consumes its ordinary budget without altering any limit.
 for(let attempt=0;attempt<3000&&!error;attempt++)try{for(const call of owner.calls)void call}catch(caught){error=caught}
 assert.ok(error);assert.match(error.message,/Service startup analysis work budget exceeded/);
 failure(()=>context.entryContexts(),/Service startup analysis work budget exceeded/);
 failure(()=>context.startup(ws.units[0].sf),/Service startup analysis work budget exceeded/);
 assert.equal(new ServiceContexts(root,ws).entryContexts().length,1);
});

test('valid static import cycles retain complete cached summaries',async t=>{
 const {root,ws}=await workspace(t,{'a.ts':`import './b';process.on('SIGTERM',()=>{});`,'b.ts':`import './a';app.get('/health',()=>{});app.listen(3000);`});
 const context=new ServiceContexts(root,ws);const entries=context.entryContexts();
 assert.equal(entries.length,1);assert.equal(entries[0].sources.size,2);
 assert.equal([...entries[0].possibleListeners].length,1);
 assert.equal([...entries[0].calls].length,3);
 assert.equal(context.entryContexts(),entries);
 assert.equal(context.startup(ws.units[0].sf),entries[0]);
});
