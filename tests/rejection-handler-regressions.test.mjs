import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

async function audit(source,verify,files={}) {
  const root=await mkdtemp(path.join(tmpdir(),'scale-rejection-handler-'));
  try {
    for(const [file,content] of Object.entries({'route.ts':source,...files})) await writeFile(path.join(root,file),content);
    const report=await runAudit(root);assert.equal(report.complete,true);return verify(report);
  } finally {await rm(root,{recursive:true,force:true});}
}
const byId=(r,id)=>r.findings.filter(f=>f.id===id);

test('async arrows, function expressions, aliases and imports retain promise origin',async()=>{
  await audit([
    "import {remoteOperation} from './operation.js';",
    "const operation=async()=>{throw new Error('x')};",
    'const expression=async function(){throw new Error("x")};',
    'const alias=operation;',
    'operation().then(()=>{});',
    'expression().finally(()=>{});',
    'alias().then(()=>{});',
    'remoteOperation().then(()=>{});',
  ].join('\n'),r=>assert.deepEqual(byId(r,'unhandled-rejection').map(f=>f.line),[5,6,7,8]),{'operation.ts':'export const remoteOperation=async()=>{throw new Error("x")};'});
});

test('bare async arrows are floating but consumed and synchronous operations stay quiet',async()=>audit([
  'const operation=async()=>{throw new Error("x")};',
  'operation();',
  'operation().catch(()=>{});',
  'async function consumed(){await operation();return operation();}',
  'const sync=()=>({then(callback){callback();}});sync().then(()=>{});',
].join('\n'),r=>{assert.deepEqual(byId(r,'floating-promise').map(f=>f.line),[2]);assert.equal(byId(r,'unhandled-rejection').length,0);}));

for(const value of ['null','undefined','42','false','"not a function"','{}'])test(`noncallable catch identifier ${value} does not handle rejection`,async()=>audit(`const handler=${value};const alias=handler;Promise.reject('x').catch(alias);`,r=>assert.equal(byId(r,'unhandled-rejection').length,1)));

test('noncallable then rejection handler also remains unhandled',async()=>audit("const handler=null;Promise.reject('x').then(()=>{},handler);",r=>assert.equal(byId(r,'unhandled-rejection').length,1)));

test('known functions, imported handlers and unknown property handlers remain accepted',async()=>audit([
  "import {handle} from './handler.js';",
  'const arrow=()=>{};const alias=arrow;function declaration(){};',
  "Promise.reject('x').catch(alias);",
  "Promise.reject('x').catch(declaration);",
  "Promise.reject('x').catch(handle);",
  "Promise.reject('x').catch(handlers.error);",
].join('\n'),r=>assert.equal(byId(r,'unhandled-rejection').length,0),{'handler.ts':'export function handle(error){}'}));


test('straight-line handler reassignment is resolved at the catch use',async()=>audit([
  "let good=null;good=()=>{};Promise.reject('x').catch(good);",
  "let bad=()=>{};bad=null;Promise.reject('x').catch(bad);",
  "let original=null;const captured=original;original=()=>{};Promise.reject('x').catch(captured);",
].join('\n'),r=>assert.deepEqual(byId(r,'unhandled-rejection').map(f=>f.line),[2,3])));

test('branch and nested handler writes remain unknown rather than initializer false positives',async()=>audit([
  "let branch=null;if(runtimeFlag){branch=()=>{}}Promise.reject('x').catch(branch);",
  "let nested=null;function set(){nested=()=>{}}set();Promise.reject('x').catch(nested);",
].join('\n'),r=>assert.equal(byId(r,'unhandled-rejection').length,0)));

test('async origins honor reassignment and capture-time aliases',async()=>audit([
  "let sync=async()=>{};sync=()=>({then(){}});sync().then(()=>{});",
  "let operation=()=>({then(){}});operation=async()=>{};operation().then(()=>{});",
  "let captured=async()=>{};const alias=captured;captured=()=>({then(){}});alias().then(()=>{});",
  "let uncertain=async()=>{};if(runtimeFlag){uncertain=()=>({then(){}})}uncertain().then(()=>{});",
].join('\n'),r=>assert.deepEqual(byId(r,'unhandled-rejection').map(f=>f.line),[2,3])));
