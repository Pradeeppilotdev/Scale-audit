import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';
async function audit(t,body){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-helper-timing-reliability-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),'{"type":"module"}');
 await writeFile(path.join(root,'main.ts'),`async function work(){throw Error('failed')} ${body}`);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.some(f=>f.id==='missing-rejection-handler');
}
test('awaited helper continuation cannot protect earlier unhandled work',async t=>{
 assert.ok(await audit(t,`work();async function setup(){await load();process.on('unhandledRejection',()=>{})}await setup();`));
});
test('awaited helper registration protects work after successful setup',async t=>{
 assert.equal(await audit(t,`async function setup(){await load();process.on('unhandledRejection',()=>{})}await setup();work();`),false);
});
test('known executed guarded registration protects work after successful await',async t=>{
 assert.equal(await audit(t,`await load();true&&process.on('unhandledRejection',()=>{});work();`),false);
});
test('unknown guarded registration cannot protect work after successful await',async t=>{
 assert.ok(await audit(t,`await load();declare const enabled:boolean;enabled&&process.on('unhandledRejection',()=>{});work();`));
});
