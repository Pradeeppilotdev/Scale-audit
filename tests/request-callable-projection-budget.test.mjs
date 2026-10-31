import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import ts from 'typescript';
import {Workspace} from '../dist/workspace.js';
import {requestReachability} from '../dist/requestReachability.js';
import {AnalysisLimitError} from '../dist/analysisBudget.js';

async function workspace(t,body){
 const root=await mkdtemp('/tmp/scale-callable-projection-');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(root+'/main.ts',`import http from 'node:http';import fs from 'node:fs';${body}`);
 return Workspace.load(root);
}
function choice(first,last,value){
 if(last-first===1)return value(first);
 const middle=(first+last)>>1;
 return`(unknown?${choice(first,middle,value)}:${choice(middle,last,value)})`;
}
function nodes(ws,predicate){
 const result=[];
 for(const{sf}of ws.units){const pending=[sf];while(pending.length){const node=pending.pop();if(predicate(node))result.push(node);ts.forEachChild(node,child=>{pending.push(child)})}}
 return result;
}
test('wide cached unions reuse callable projections without quadratic member inspection',async t=>{
 const width=300;
 const ws=await workspace(t,`const target=${choice(0,width,()=>'{ }')};http.createServer(()=>{${'target();'.repeat(width)}});`);
 const objects=nodes(ws,ts.isObjectLiteralExpression);
 const descriptors=objects.map(node=>Object.getOwnPropertyDescriptor(node,'kind'));
 let reads=0;
 try{
  objects.forEach(node=>Object.defineProperty(node,'kind',{configurable:true,get(){reads++;return ts.SyntaxKind.ObjectLiteralExpression}}));
  requestReachability(ws);
 }finally{objects.forEach((node,index)=>Object.defineProperty(node,'kind',descriptors[index]))}
 // Count semantic member inspections, not machine-dependent elapsed time.
 // The original two repeated filters alone inspected 2 * width^2 members.
 assert.ok(reads<width*250,`repeated cached union scans inspected object kinds ${reads} times`);
});
test('large cached noncallable unions finish within the unchanged work budget',async t=>{
 const width=1200;
 const ws=await workspace(t,`const target=${choice(0,width,()=>'{ }')};http.createServer(()=>{${'target();'.repeat(width)}});`);
 assert.doesNotThrow(()=>requestReachability(ws));
});
test('callable projection retains live functions in mixed value unions',async t=>{
 const ws=await workspace(t,`function read(){fs.readFileSync('live')}const target=unknown?{}:read;http.createServer(()=>target());`);
 const graph=requestReachability(ws);
 const reads=nodes(ws,node=>ts.isCallExpression(node)&&node.expression.getText()==='fs.readFileSync');
 assert.deepEqual(reads.map(node=>graph.evidence(node)),['request']);
});
test('distinct callable unions preserve their callback bindings',async t=>{
 const ws=await workspace(t,`function run(fn){fn()}function read(){fs.readFileSync('live')}function unused(){fs.writeFileSync('dead','x')}function quiet(){}const first=unknown?run:quiet;const second=unknown?quiet:run;http.createServer(()=>{first(read);second(quiet)});`);
 const graph=requestReachability(ws);
 const calls=nodes(ws,node=>ts.isCallExpression(node)&&/^fs\.(readFileSync|writeFileSync)$/.test(node.expression.getText()));
 assert.equal(calls.filter(node=>graph.evidence(node)==='request').length,1);
 assert.equal(graph.evidence(calls.find(node=>node.expression.getText()==='fs.writeFileSync')),undefined);
});
test('genuinely distinct wide invocations remain strict on work exhaustion',async t=>{
 const width=350;
 const functions=Array.from({length:width},(_,index)=>`function f${index}(callback){}`).join('');
 const calls=Array.from({length:width},()=>`target(()=>{});`).join('');
 const ws=await workspace(t,`${functions}const target=${choice(0,width,index=>'f'+index)};http.createServer(()=>{${calls}});`);
 assert.throws(()=>requestReachability(ws),error=>error instanceof AnalysisLimitError&&/Request reachability analysis work budget exceeded/.test(error.message));
});
