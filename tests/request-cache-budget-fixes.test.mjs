import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import {Workspace} from '../dist/workspace.js';
import {requestReachability} from '../dist/requestReachability.js';
import {AnalysisLimitError} from '../dist/analysisBudget.js';

async function workspace(t,body){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-request-key-budget-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'main.ts'),`import http from 'node:http';import fs from 'node:fs';${body}`);
 return Workspace.load(root);
}
function readEvidence(ws,reachability){
 const found=[];
 for(const{sf}of ws.units){const pending=[sf];while(pending.length){const node=pending.pop();if(ts.isCallExpression(node)&&node.expression.getText()==='fs.readFileSync')found.push(reachability.evidence(node));ts.forEachChild(node,child=>{pending.push(child)})}}
 return found;
}
for(const factory of [false,true])test(`wide shared argument keys are cached before repeated ${factory?'factory':'invocation'} lookups`,async t=>{
 const width=300;
 const calls=factory?'consume(wrap(p));':'consume(p);';
 const ws=await workspace(t,`function consume(p){}function wrap(p){return()=>p}function run(p){${calls.repeat(width)}fs.readFileSync('live')}http.createServer(()=>run([${Array.from({length:width},(_,i)=>i).join(',')}]));`);
 // Count observable key reads rather than imposing a machine-dependent time
 // limit. Rebuilding each numeric value's identity per call is quadratic.
 const original=WeakMap.prototype.get;
 let numericReads=0;
 let reachability;
 try{
  WeakMap.prototype.get=function(key){if(key&&typeof key==='object'&&key.kind===ts.SyntaxKind.NumericLiteral)numericReads++;return original.call(this,key)};
  reachability=requestReachability(ws);
 }finally{WeakMap.prototype.get=original}
 assert.deepEqual(readEvidence(ws,reachability),['request']);
 assert.ok(numericReads<width*20,`expected cached linear key reads, got ${numericReads} for ${width} values/calls`);
});
test('canonical argument signatures preserve distinct callback identities and argument positions',async t=>{
 const ws=await workspace(t,`function invoke(first,second){first()}function read(){fs.readFileSync('live')}function unused(){fs.readFileSync('unused')}function quiet(){}http.createServer(()=>{invoke(quiet,unused);invoke(read,quiet)});`);
 const found=readEvidence(ws,requestReachability(ws));
 assert.equal(found.filter(value=>value==='request').length,1);
 assert.equal(found.length,2);
});
test('factory signatures preserve callback bindings for separate argument values',async t=>{
 const ws=await workspace(t,`function wrap(fn){return()=>fn()}function read(){fs.readFileSync('live')}function unused(){fs.readFileSync('unused')}function quiet(){}const one=wrap(read);const two=wrap(unused);http.createServer(one);`);
 const found=readEvidence(ws,requestReachability(ws));
 assert.equal(found.filter(value=>value==='request').length,1);
 assert.equal(found.length,2);
});
test('unused bound-target unions charge every copied argument slot',async t=>{
 const width=600;
 const choice=(first,last)=>{if(last-first===1)return'f'+first;const middle=(first+last)>>1;return`(unknown?${choice(first,middle)}:${choice(middle,last)})`};
 const body=`${Array.from({length:width},(_,index)=>`function f${index}(){}`).join('')}const target=${choice(0,width)};function ignore(fn){}http.createServer(()=>ignore(target.bind(null,${Array(width).fill('0').join(',')})));`;
 const ws=await workspace(t,body);
 assert.throws(()=>requestReachability(ws),error=>error instanceof AnalysisLimitError&&/Request reachability analysis work budget exceeded/.test(error.message));
});
