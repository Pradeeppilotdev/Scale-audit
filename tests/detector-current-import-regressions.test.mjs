import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {detectInProcessState} from '../dist/detectors/inProcessState.js';
import {detectUnboundedConcurrency} from '../dist/detectors/unboundedConcurrency.js';
import {AnalysisBudget} from '../dist/analysisBudget.js';
async function fixture(t,files){const root=await mkdtemp(join(tmpdir(),'scale-detector-current-import-'));t.after(()=>rm(root,{recursive:true,force:true}));for(const [file,source]of Object.entries(files))await writeFile(join(root,file),source);return root;}

for(const [label,setup,expected]of[
 ['native',"export let make=middleware;",1],
 ['replaced',"export let make=middleware;make=()=>{};",0],
 ['restored',"export let make=()=>{};make=middleware;",1],
 ['captured native',"let current=middleware;export const make=current;current=()=>{};",1],
 ['captured local',"let current=()=>{};export const make=current;current=middleware;",0],
 ['conditional replacement',"export let make=middleware;if(flag)make=()=>{};",0],
 ['post-startup replacement',"export let make=middleware;export function replace(){make=()=>{}}",0],
])for(const namespace of[false,true])for(const [pkg,id]of[['express-session','in-process-session'],['express-rate-limit','in-memory-rate-limit']]){
 test(`${pkg} ${label} ${namespace?'namespace':'named'} export retains current identity`,async t=>{
  const entry=namespace?"import * as bridge from './bridge.js';bridge.make({});":"import {make}from'./bridge.js';make({});";
  const root=await fixture(t,{'bridge.js':`import middleware from '${pkg}';${setup}`,'route.ts':entry});
  assert.equal((await detectInProcessState(root)).filter(f=>f.id===id&&f.file==='route.ts').length,expected);
 });
}

for(const [label,setup,expected]of[
 ['native',"const limit=pLimit(5);",0],
 ['replaced factory',"let make=pLimit;make=()=>fn=>fn();const limit=make(5);",1],
 ['restored factory',"let make=()=>fn=>fn();make=pLimit;const limit=make(5);",0],
 ['captured native factory',"let make=pLimit;const captured=make;make=()=>fn=>fn();const limit=captured(5);",0],
 ['captured local factory',"let make=()=>fn=>fn();const captured=make;make=pLimit;const limit=captured(5);",1],
 ['already allocated native limiter',"let make=pLimit;const limit=make(5);make=()=>fn=>fn();",0],
])test(`limiter factory identity: ${label}`,async t=>{
 const root=await fixture(t,{'route.ts':`import pLimit from'p-limit';${setup}export function GET(users){return Promise.all(users.map(user=>limit(()=>fetch(user.url))));}`});
 assert.equal((await detectUnboundedConcurrency(root)).length,expected);
});

for(const [setup,expected]of[["export let make=pLimit;make=()=>fn=>fn();",1],["export let make=()=>fn=>fn();make=pLimit;",0]])for(const namespace of[false,true])test(`cross-file limiter factory ${namespace?'namespace':'named'}: ${setup}`,async t=>{
 const entry=namespace?"import * as bridge from './bridge.js';const limit=bridge.make(5);":"import {make}from'./bridge.js';const limit=make(5);";
 const root=await fixture(t,{'bridge.js':`import pLimit from'p-limit';${setup}`,'route.ts':entry+"export function GET(users){return Promise.all(users.map(user=>limit(()=>fetch(user.url))));}"});
 assert.equal((await detectUnboundedConcurrency(root)).length,expected);
});

test('namespace middleware suffixes reuse the cached local alias prefix',async t=>{
 const work=[];
 for(const count of[250,500]){
  const aliases=Array.from({length:30},(_,i)=>`const alias${i}=${i?'alias'+(i-1):'bridge'};`).join('');
  const root=await fixture(t,{'bridge.js':"import session from'express-session';export const make=session;",'route.ts':"import*as bridge from'./bridge.js';"+aliases+"alias29.make({store:shared});".repeat(count)});
  const take=AnalysisBudget.prototype.take;let units=0;AnalysisBudget.prototype.take=function(n=1){if(this.label==='Promise binding writes')units+=n;return take.call(this,n)};
  try{assert.equal((await detectInProcessState(root)).length,0);work.push(units);}finally{AnalysisBudget.prototype.take=take;}
 }
 assert.ok(work[1]<work[0]*2.4,`expected cached receiver provenance: ${work}`);
});
