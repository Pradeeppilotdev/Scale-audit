import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import {runAudit} from '../dist/runner.js';
import {Workspace} from '../dist/workspace.js';
import {serviceContexts} from '../dist/serviceContext.js';
async function fixture(t,files){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-property-collection-shared-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),JSON.stringify({dependencies:{express:'*'}}));
 for(const [name,source]of Object.entries(files))await writeFile(path.join(root,name),source);
 return root;
}
const lifecycle=r=>r.findings.filter(f=>['missing-health-endpoint','missing-graceful-shutdown'].includes(f.id));
for(const [label,source,receiver]of [
 ['property',`const registry={cache:new Map()};`,'registry.cache'],
 ['large property registry',`const registry={cache:new Map(),${Array.from({length:500},(_,i)=>`padding${i}:${i}`).join(',')}};`,'registry.cache'],
 ['nested element',`const registry={inner:{cache:new Map()}};` ,`registry['inner']['cache']`],
 ['captured property alias',`const registry={cache:new Map()};const cache=registry.cache;`,'cache'],
 ['erased wrappers',`const registry={cache:new Map()} satisfies any;`, `(registry.cache satisfies any)`],
 ['angle assertion',`const registry={cache:new Map()};`, `(<any>registry.cache)`],
])test(`100 services share 1000 invariant ${label} collection calls`,async t=>{
 const files={'shared.ts':source+`declare const key:any;`+Array.from({length:1000},()=>`${receiver}.get(key);`).join('\n')};
 for(let i=0;i<100;i++)files[`entry${i}.ts`]=`import './shared';import express from 'express';const app=express();app.listen(${3000+i});`;
 const report=await runAudit(await fixture(t,files));
 assert.equal(report.complete,true,JSON.stringify(report.detectors));assert.equal(report.coverage.analyzed,101);
 assert.equal(lifecycle(report).length,200);
});
// Query the semantic index directly: even when a receiver's eventual route is
// unresolved, mutation and escape must retain it for invocation-level analysis.
for(const [label,source]of [
 ['direct replacement',`const registry={cache:new Map()};registry.cache=server;`],
 ['alias replacement',`const registry={cache:new Map()};const alias=registry;alias.cache=server;`],
 ['helper escape',`const registry={cache:new Map()};function replace(target){target.cache=server}replace(registry);`],
 ['own method mutation',`const registry={cache:new Map(),replace(){this.cache=server}};registry.replace();`],
 ['accessor mutation',`const registry={cache:new Map(),get replace(){this.cache=server;return 1}};void registry.replace;`],
 ['unknown escape',`const registry={cache:new Map()};mutate(registry);`],
 ['wrapper escape',`const registry={cache:new Map()};mutate({registry});`],
 ['array escape',`const registry={cache:new Map()};mutate([registry]);`],
 ['mutable alias',`const registry={cache:new Map()};let alias=registry;alias.cache=server;`],
 ['array cell alias',`const registry={cache:new Map()};const aliases=[registry];aliases[0].cache=server;`],
 ['class field alias',`const registry={cache:new Map()};class Holder{static alias=registry}Holder.alias.cache=server;`],
 ['default parameter alias',`const registry={cache:new Map()};function replace(target=registry){target.cache=server}replace();`],
 ['thrown alias',`const registry={cache:new Map()};try{throw registry}catch(alias){alias.cache=server}`],
 ['yielded alias',`const registry={cache:new Map()};function* expose(){yield registry}const alias=expose().next().value;alias.cache=server;`],
 ['tagged substitution alias',`const registry={cache:new Map()};mutate\`\${registry}\`;`],
 ['destructured alias',`const registry={inner:{cache:new Map()}};const {inner}=registry;inner.cache=server;`],
 ['Object.assign mutation',`const registry={cache:new Map()};Object.assign(registry,{cache:server});`],
 ['exported allocation',`export const registry={cache:new Map()};`],
 ['named export allocation',`const registry={cache:new Map()};export{registry};`],
 ['shadowed constructor',`class Map{get(){}}const registry={cache:new Map()};`],
 ['unknown receiver',`declare const registry:any;`],
])test(`collection candidate filtering retains ${label}`,async t=>{
 const receiver=label==='destructured alias'?'registry.inner.cache':'registry.cache';
 const root=await fixture(t,{'main.ts':`declare const server:any;${source}declare const key:any;${receiver}.get(key);`});
 const ws=await Workspace.load(root);const owner=serviceContexts(root,ws).entryContexts()[0];
 assert.ok([...owner.protectiveCalls].some(call=>ts.isPropertyAccessExpression(call.expression)&&call.expression.name.text==='get'));
});
test('actual HTTP replacement keeps valid health protection',async t=>{
 const report=await runAudit(await fixture(t,{'main.ts':`import express from 'express';const registry={cache:new Map()};registry.cache=express();registry.cache.get('/health',()=> 'ok');process.on('SIGTERM',()=>{});registry.cache.listen(3000);`}));
 assert.equal(report.complete,true,JSON.stringify(report.detectors));assert.equal(lifecycle(report).length,0);
});
test('dynamic helper-bound server route remains eligible',async t=>{
 const report=await runAudit(await fixture(t,{'main.ts':`import express from 'express';const app=express();function install(registry,path){registry.cache.get(path,()=> 'ok')}install({cache:app},'/health');process.on('SIGTERM',()=>{});app.listen(3000);`}));
 assert.equal(report.complete,true,JSON.stringify(report.detectors));assert.equal(lifecycle(report).length,0);
});
