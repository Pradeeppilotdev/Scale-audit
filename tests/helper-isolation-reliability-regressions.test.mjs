import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';
async function missingHandler(t,body){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-helper-isolation-reliability-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'package.json'),'{"type":"module"}');
 await writeFile(path.join(root,'main.ts'),`async function work(){throw Error('failed')} ${body}`);
 const report=await runAudit(root);assert.equal(report.complete,true,JSON.stringify(report.detectors));
 return report.findings.some(f=>f.id==='missing-rejection-handler');
}
const setup=`async function setup(enabled){await load();if(enabled)process.on('unhandledRejection',()=>{})}`;
test('later helper invocation cannot protect earlier repeated work site',async t=>{
 assert.ok(await missingHandler(t,setup+`async function boot(enabled){await setup(enabled);work()}await boot(false);await boot(true);`));
});
test('all protected helper invocations retain rejection evidence',async t=>{
 assert.equal(await missingHandler(t,setup+`async function boot(enabled){await setup(enabled);work()}await boot(true);await boot(true);`),false);
});
test('awaited work argument completes setup before the unhandled call',async t=>{
 assert.equal(await missingHandler(t,setup+`work(await setup(true));`),false);
});
test('awaited work argument without registration cannot invent protection',async t=>{
 assert.ok(await missingHandler(t,setup+`work(await setup(false));`));
});
