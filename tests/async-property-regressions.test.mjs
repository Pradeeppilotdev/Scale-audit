import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

async function audit(source,verify) {
 const root=await mkdtemp(path.join(tmpdir(),'scale-async-property-'));
 try {await writeFile(path.join(root,'route.ts'),source);const r=await runAudit(root);assert.equal(r.complete,true);return verify(r);}
 finally {await rm(root,{recursive:true,force:true});}
}
const floating=r=>r.findings.filter(f=>f.id==='floating-promise');

test('object async-property calls retain promise origin',()=>audit("const api={handler:async()=>{throw new Error('boom')}};export function GET(){api.handler();}",r=>assert.equal(floating(r).length,1)));
test('class async-field calls retain promise origin',()=>audit("class Service{handler=async()=>{throw new Error('boom')};run(){this.handler();}}export function GET(){return new Service().run();}",r=>assert.equal(floating(r).length,1)));
for(const source of [
 "const api={handler:async()=>{}};api.handler=()=>{};export function GET(){api.handler();}",
 "const api={handler:async()=>{}};api.handler=()=>{};api.handler();",
])test('straight-line sync property replacement removes stale async proof',()=>audit(source,r=>assert.equal(floating(r).length,0)));
for(const source of [
 "const api={handler:()=>{}};api.handler=async()=>{};export function GET(){api.handler();}",
 "const api={handler:()=>{}};api.handler=async()=>{};api.handler();",
 "const api={handler:()=>{}};api.handler=async()=>{};export const GET=()=>{api.handler();};",
])test('straight-line async property replacement restores promise proof',()=>audit(source,r=>assert.equal(floating(r).length,1)));
test('property writes are scoped to declaration rather than spelling',()=>audit("const a={handler:async()=>{}},b={handler:async()=>{}};a.handler=()=>{};export function GET(){a.handler();b.handler();}",r=>assert.equal(floating(r).length,1)));
for(const source of [
 "const api={handler:async()=>{}};if(runtimeFlag){api.handler=()=>{}}export function GET(){api.handler();}",
 "const api={handler:async()=>{}};function replace(){api.handler=()=>{}}replace();export function GET(){api.handler();}",
 "const api={handler:async()=>{}};api.handler ||= ()=>{};export function GET(){api.handler();}",
 "class Service{handler=async()=>{};replace(){this.handler=()=>{}}run(){this.handler();}}export function GET(){return new Service().run();}",
])test('conditional, nested and compound property writes are unknown',()=>audit(source,r=>assert.equal(floating(r).length,0)));
test('consumed async-property calls remain quiet',()=>audit("const api={handler:async()=>{}};export async function GET(){await api.handler();api.handler().catch(()=>{});return api.handler();}",r=>assert.equal(floating(r).length,0)));
test('property async origins feed unhandled rejection chains',()=>audit("const api={handler:async()=>{}};export function GET(){api.handler().then(()=>{});}",r=>assert.equal(r.findings.filter(f=>f.id==='unhandled-rejection').length,1)));
test('void async-property call retains explicit discard behavior',()=>audit("const api={handler:async()=>{}};export function GET(){void api.handler();}",r=>assert.equal(floating(r).length,0)));

for(const source of [
 "const api={handler:()=>{}};GET();api.handler=async()=>{};export function GET(){api.handler();}",
 "const api={handler:()=>{}};export const GET=()=>{api.handler();};GET();api.handler=async()=>{};",
 "const api={handler:()=>{}};export function GET(){api.handler();}const early=GET;early();api.handler=async()=>{};",
])test('locally referenced exported entry does not assume final startup property value',()=>audit(source,r=>assert.equal(floating(r).length,0)));
