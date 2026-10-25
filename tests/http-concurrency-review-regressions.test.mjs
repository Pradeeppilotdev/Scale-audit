import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAudit } from '../dist/runner.js';

async function audit(source, verify) {
 const root=await mkdtemp(path.join(tmpdir(),'scale-http-concurrency-'));
 try { await writeFile(path.join(root,'route.ts'),source);const r=await runAudit(root);assert.equal(r.complete,true);return verify(r); }
 finally { await rm(root,{recursive:true,force:true}); }
}
const findings=(r,id)=>r.findings.filter(f=>f.id===id);
for(const source of [
 "const http={request(){return 1}};export function GET(){return http.request({});}",
 "export function GET(https){return https.request({});}",
 "const transport={get(){return 1}};export function GET(){return transport.get({});}",
])test('local HTTP-like names do not imply native HTTP',()=>audit(source,r=>assert.equal(findings(r,'outbound-no-timeout').length,0)));
for(const source of [
 "import * as transport from 'node:http';export function GET(){return transport.request('http://example.com');}",
 "import transport from 'https';export function GET(){return transport.get('https://example.com');}",
 "import {request as send} from 'node:https';export function GET(){return send('https://example.com');}",
 "const {request:send}=require('http');export function GET(){return send('http://example.com');}",
])test('native HTTP imported aliases retain identity',()=>audit(source,r=>assert.equal(findings(r,'outbound-no-timeout').length,1)));
for(const source of [
 "const AbortSignal={timeout(){return undefined}};export function GET(){return fetch('https://example.com',{signal:AbortSignal.timeout(5000)});}",
 "export function GET(AbortSignal){return fetch('https://example.com',{signal:AbortSignal.timeout(5000)});}",
 "const globalThis={AbortSignal:{timeout(){return undefined}}};export function GET(){return fetch('https://example.com',{signal:globalThis.AbortSignal.timeout(5000)});}",
])test('shadowed AbortSignal cannot prove cancellation deadline',()=>audit(source,r=>assert.equal(findings(r,'outbound-no-timeout').length,1)));
for(const signal of ['AbortSignal.timeout(5000)','globalThis.AbortSignal.timeout(5000)','AbortSignal.any([controller.signal,globalThis.AbortSignal.timeout(5000)])'])test('real global timer signals prove a deadline',()=>audit(`export function GET(){return fetch('https://example.com',{signal:${signal}});}`,r=>assert.equal(findings(r,'outbound-no-timeout').length,0)));

test('uppercase user-sized collections retain concurrency findings',()=>audit("export function GET(USERS){return Promise.all(USERS.map(user=>fetch(user.url)));}",r=>assert.equal(findings(r,'unbounded-concurrency').length,1)));
for(const callback of ['user=>user.id','user=>({id:user.id})','user=>{const id=user.id;return id;}'])test('synchronous projection does not schedule concurrent tasks',()=>audit(`export function GET(users){return Promise.all(users.map(${callback}));}`,r=>assert.equal(findings(r,'unbounded-concurrency').length,0)));
test('shadowed Promise.all is excluded',()=>audit("const Promise={all(value){return value}};export function GET(users){return Promise.all(users.map(user=>fetch(user.url)));}",r=>assert.equal(findings(r,'unbounded-concurrency').length,0)));
test('limiter aliases retain bounded concurrency',()=>audit("import pLimit from 'p-limit';const limit=pLimit(5);const bounded=limit;export function GET(users){return Promise.all(users.map(user=>bounded(()=>fetch(user.url))));}",r=>assert.equal(findings(r,'unbounded-concurrency').length,0)));
test('unlimited calls still warn',()=>audit("export function GET(users){return Promise.all(users.map(user=>fetch(user.url)));}",r=>assert.equal(findings(r,'unbounded-concurrency').length,1)));
for(const binding of ['{url}','{url:target}','[target]','{nested:{url:target}}'])test(`destructured awaited dependency ${binding} cannot be parallelized`,()=>audit(`export async function GET(){const ${binding}=await db.query(sql);const response=await fetch(${binding==='{url}'?'url':'target'});return response;}`,r=>assert.equal(findings(r,'sequential-awaits').length,0)));
test('independent awaits still warn',()=>audit("export async function GET(){const rows=await db.query(sql);const response=await fetch(endpoint);return response;}",r=>assert.equal(findings(r,'sequential-awaits').length,1)));

test('reassigned limiter aliases do not suppress unbounded work',()=>audit("import pLimit from 'p-limit';const limit=pLimit(5);let bounded=limit;bounded=fn=>fn();export function GET(users){return Promise.all(users.map(user=>bounded(()=>fetch(user.url))));}",r=>assert.equal(findings(r,'unbounded-concurrency').length,1)));

test('reassigned map callback cannot prove synchronous work',()=>audit("let worker=user=>user.id;worker=user=>fetch(user.url);export function GET(users){return Promise.all(users.map(worker));}",r=>assert.equal(findings(r,'unbounded-concurrency').length,1)));
test('immutable synchronous callback aliases remain quiet',()=>audit("const worker=user=>user.id;const project=worker;export function GET(users){return Promise.all(users.map(project));}",r=>assert.equal(findings(r,'unbounded-concurrency').length,0)));
