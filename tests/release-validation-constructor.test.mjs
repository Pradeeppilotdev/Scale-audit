import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';
async function findings(t,body){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-release-constructor-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),'{"type":"module","dependencies":{"express":"*"}}');
 await writeFile(path.join(root,'main.ts'),`import express from 'express';const app=express();async function install(){await load();app.get('/health',()=> 'ok');process.on('SIGTERM',()=>{});process.on('unhandledRejection',()=>{})}async function work(){throw Error()}${body}await(api.ready()&&install());app.listen(3000);work();`);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.filter(f=>['missing-health-endpoint','missing-graceful-shutdown','missing-rejection-handler'].includes(f.id));
}
const allocations=[
 `const registry={0:class{async ready(){}}};const api=new registry[0]();`,
 `const registry={Api:class{async ready(){}}};const holder={nested:{instance:new registry.Api()}};const api=holder.nested.instance;`,
];
for(const body of allocations)for(const mutation of ['',`Object.assign(api,{ready:()=>false});`])test('release validation keeps constructor and instance aliases separate: '+body+' '+(mutation?'mutated':'stable'),async t=>{
 assert.equal((await findings(t,body+mutation)).length,mutation?3:0);
});
