import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';
async function missingHandler(t,body){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-startup-evidence-reliability-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),'{"type":"module"}');
 await writeFile(path.join(root,'types.ts'),'export interface Foo { value: string }');
 await writeFile(path.join(root,'main.ts'),`async function work(){throw Error('failed')} ${body}`);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.some(f=>f.id==='missing-rejection-handler');
}
test('type import preserves completed rejection-handler setup',async t=>{
 assert.equal(await missingHandler(t,`async function setup(){await load();process.on('unhandledRejection',()=>{})}await setup();import type{Foo}from './types';work();`),false);
});
test('optional receiver registration remains unconditional after await',async t=>{
 assert.equal(await missingHandler(t,`await load();declare const maybe:any;(process.on('unhandledRejection',()=>{}),maybe)?.();work();`),false);
});
test('optional arguments remain conditional after await',async t=>{
 assert.ok(await missingHandler(t,`await load();declare const maybe:any;maybe?.(process.on('unhandledRejection',()=>{}));work();`));
});
for(const member of [`static{process.on('unhandledRejection',()=>{})}`,`static handler=process.on('unhandledRejection',()=>{})`])test('executed class initialization retains rejection-handler setup: '+member,async t=>{
 assert.equal(await missingHandler(t,`await load();class Setup{${member}}work();`),false);
});
test('unconstructed instance field cannot establish rejection protection',async t=>{
 assert.ok(await missingHandler(t,`await load();class Setup{handler=process.on('unhandledRejection',()=>{})}work();`));
});
