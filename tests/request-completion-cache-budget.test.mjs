import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import ts from 'typescript';
import {Workspace} from '../dist/workspace.js';
import {requestReachability} from '../dist/requestReachability.js';
import {AnalysisLimitError} from '../dist/analysisBudget.js';
import {runAudit} from '../dist/runner.js';

async function fixture(t,body){
 const root=await mkdtemp('/tmp/scale-completion-cache-budget-');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(root+'/main.ts',`import http from 'node:http';import fs from 'node:fs';${body}`);
 return Workspace.load(root);
}
function chain(warm,count=25){
 return `function leaf(){const value=${'('.repeat(70)}0${')'.repeat(70)}}`+
  Array.from({length:count},(_,index)=>`function h${index}(){${index===0?'leaf':'h'+(index-1)}()}`).join('')+
  `http.createServer(()=>{${warm?'leaf();':''}h${count-1}()});`;
}
const depthFailure=error=>error instanceof AnalysisLimitError&&/Request binding resolution depth limit exceeded/.test(error.message);
for(const warm of [false,true])test('completion depth remains strict with '+(warm?'a warmed':'a cold')+' leaf summary',async t=>{
 const ws=await fixture(t,chain(warm));
 assert.throws(()=>requestReachability(ws),depthFailure);
});
test('a cached depth failure remains an incomplete audit',async t=>{
 const ws=await fixture(t,chain(true));
 const report=await runAudit(ws.root);
 assert.equal(report.complete,false);
 assert.ok(report.detectors.some(detector=>detector.name==='detectSyncIo'&&detector.status==='failed'&&/Request binding resolution depth limit exceeded/.test(detector.reason)));
 assert.throws(()=>requestReachability(ws),depthFailure);
});
test('ordinary warmed completion summaries remain reusable within the same depth limit',async t=>{
 const ws=await fixture(t,chain(true,8));
 assert.doesNotThrow(()=>requestReachability(ws));
});
function choice(first,last){
 if(last-first===1)return'f'+first;
 const middle=(first+last)>>1;
 return`(unknown?${choice(first,middle)}:${choice(middle,last)})`;
}
test('escape checks reuse consumer safety instead of rescanning wide cached callable unions',async t=>{
 const width=600;
 const ws=await fixture(t,Array.from({length:width},(_,index)=>`function f${index}(){}`).join('')+
  `const target=${choice(0,width)};function unused(){${'target({});'.repeat(width)}}http.createServer(()=>{});`);
 const originals=[];
 let reads=0;
 try{
  for(const{sf}of ws.units){
   const visit=node=>{
    if(ts.isFunctionDeclaration(node)&&/^f\d+$/.test(node.name?.text??'')){
     const descriptor=Object.getOwnPropertyDescriptor(node,'parameters');
     originals.push([node,descriptor]);
     Object.defineProperty(node,'parameters',{configurable:true,get(){reads++;return descriptor.value}});
    }
    ts.forEachChild(node,visit);
   };
   visit(sf);
  }
  assert.doesNotThrow(()=>requestReachability(ws));
 }finally{for(const[node,descriptor]of originals)Object.defineProperty(node,'parameters',descriptor)}
 assert.ok(reads<width*20,`expected linear cached consumer checks, observed ${reads} parameter reads`);
});
test('large unused helper consumer unions complete within unchanged work limits',async t=>{
 const width=1200;
 const ws=await fixture(t,Array.from({length:width},(_,index)=>`function f${index}(){}`).join('')+
  `const target=${choice(0,width)};function unused(){${'target({});'.repeat(width)}}http.createServer(()=>{});`);
 assert.doesNotThrow(()=>requestReachability(ws));
});
test('consumer safety cache keeps argument positions distinct',async t=>{
 const ws=await fixture(t,`function first(a,b){external(b)}function second(a,b){external(b)}const target=unknown?first:second;const items=[];target(items);target({},items);http.createServer(()=>items.map(()=>fs.readFileSync('possible')));`);
 const graph=requestReachability(ws);
 const found=[];
 for(const{sf}of ws.units){const visit=node=>{if(ts.isCallExpression(node)&&node.expression.getText()==='fs.readFileSync')found.push(graph.evidence(node));ts.forEachChild(node,visit)};visit(sf)}
 assert.deepEqual(found,['possible']);
});
