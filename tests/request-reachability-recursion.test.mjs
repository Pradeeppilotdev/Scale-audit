import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {detectSyncIo} from '../dist/detectors/syncIo.js';
import {AnalysisLimitError} from '../dist/analysisBudget.js';

async function fixture(t,source){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-request-recursion-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'main.ts'),source);
 return root;
}

for(const declarations of [
 `const handler=identity(handler);http.createServer(handler);`,
 `const first=identity(second);const second=identity(first);http.createServer(first);`,
])test('cyclic call-value bindings remain unresolved without overflowing native stacks: '+declarations,async t=>{
 const root=await fixture(t,`import http from'node:http';function identity(value){return value}${declarations}`);
 assert.deepEqual(await detectSyncIo(root),[]);
});

test('ordinary recursive request helpers retain their blocking I/O finding',async t=>{
 const root=await fixture(t,`import http from'node:http';import fs from'node:fs';function read(){if(Math.random()<0.5)return fs.readFileSync('live');return read()}http.createServer(()=>read());`);
 const findings=await detectSyncIo(root);
 assert.equal(findings.length,1);assert.equal(findings[0].severity,'high');
});

test('deep request binding resolution fails with a typed limit rather than native stack overflow',async t=>{
 const root=await fixture(t,`import{createServer}from'node:http';import fs from'node:fs';const alias0=createServer;${Array.from({length:180},(_,index)=>`const alias${index+1}=alias${index};`).join('')}alias180(()=>fs.readFileSync('live'));`);
 await assert.rejects(detectSyncIo(root),error=>error instanceof AnalysisLimitError&&/depth|resolution|budget/i.test(error.message));
});

for(const[call,expected]of[
 ['read()',true],
 ['read(undefined)',true],
 ['read(void 0)',true],
 ["read('known')",false],
 ['read(null)',false],
])test('request helper parameter defaults follow actual supplied values: '+call,async t=>{
 const root=await fixture(t,`import http from'node:http';import fs from'node:fs';function read(value=fs.readFileSync('default')){return value}http.createServer(()=>${call});`);
 const findings=await detectSyncIo(root);
 assert.equal(findings.length,1);assert.equal(findings[0].severity==='high',expected);
});
