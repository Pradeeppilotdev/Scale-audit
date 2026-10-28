import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';
async function missingHandler(t,body){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-returned-promises-reliability-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),'{"type":"module"}');
 await writeFile(path.join(root,'setup.ts'),`process.on('unhandledRejection',()=>{});`);
 await writeFile(path.join(root,'main.ts'),`async function work(){throw Error('failed')}async function install(){await load();process.on('unhandledRejection',()=>{})}${body}`);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.some(f=>f.id==='missing-rejection-handler');
}
for(const prefix of ['', 'async '])test('awaited wrapper adopts rejection-handler setup: '+(prefix||'sync'),async t=>{
 assert.equal(await missingHandler(t,`${prefix}function setup(){return install()}await setup();work();`),false);
});
test('returned setup promise cannot backfill earlier unhandled work',async t=>{
 assert.ok(await missingHandler(t,`function setup(){return install()}work();await setup();`));
});
test('erased await wrapper retains completed helper registration',async t=>{
 assert.equal(await missingHandler(t,`await (install() satisfies Promise<void>);work();`),false);
});
for(const wrapper of ['as Promise<any>','satisfies Promise<any>'])test('erased await wrapper retains imported registration: '+wrapper,async t=>{
 assert.equal(await missingHandler(t,`await (import('./setup') ${wrapper});work();`),false);
});
