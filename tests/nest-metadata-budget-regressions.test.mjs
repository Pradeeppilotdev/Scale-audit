import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ts from 'typescript';
import {Workspace} from '../dist/workspace.js';
import {providerLifetimes} from '../dist/lifetimes.js';
import {AnalysisBudget,AnalysisLimitError} from '../dist/analysisBudget.js';
import {runAudit} from '../dist/runner.js';
async function fixture(t,files){const root=await mkdtemp(join(tmpdir(),'scale-nest-metadata-budget-'));t.after(()=>rm(root,{recursive:true,force:true}));for(const [file,source]of Object.entries(files))await writeFile(join(root,file),source);return {root,workspace:await Workspace.load(root)};}
function chain(count,reverse=false,cycle=false){const files={};const name=i=>`m${String(reverse?count-i:i).padStart(3,'0')}.ts`;for(let i=0;i<count;i++){const next=i+1<count?i+1:cycle?0:undefined;files[name(i)]=`import{Module}from'@nestjs/common';${next!==undefined?`import{M${next}}from'./${name(next).replace('.ts','.js')}';`:''}@Module({imports:[${next!==undefined?`M${next}`:''}]})export class M${i}{}`;}return files;}

for(const decorated of[false,true])test(`wide inherited ${decorated?'decorated':'plain'} members are indexed once and charged`,async t=>{
 const measured=[];
 for(const count of[500,1000]){
  const source=(decorated?"import{Injectable}from'@nestjs/common';@Injectable()":"")+`class Base{${Array.from({length:count},(_,i)=>`field${i}=1;`).join('')}}${Array.from({length:count},(_,i)=>`${decorated?'@Injectable()':''}class C${i} extends Base{}`).join('\n')}`;
  const {workspace}=await fixture(t,{'main.ts':source});const base=workspace.units[0].sf.statements.find(ts.isClassDeclaration);let visits=0,charged=0;
  const iterator=base.members[Symbol.iterator],filter=base.members.filter,take=AnalysisBudget.prototype.take;
  base.members[Symbol.iterator]=function*(){for(const member of iterator.call(this)){visits++;yield member;}};
  base.members.filter=function(...args){visits+=this.length;return filter.apply(this,args)};
  AnalysisBudget.prototype.take=function(n=1){if(this.label==='Nest lifetime')charged+=n;return take.call(this,n)};
  try{const result=providerLifetimes(workspace);assert.equal(result.size,decorated?count+1:0);assert.ok(visits<=count*3,`expected one member index, saw ${visits}`);assert.ok(charged>=visits);measured.push(charged);}finally{base.members[Symbol.iterator]=iterator;base.members.filter=filter;AnalysisBudget.prototype.take=take;}
 }
 assert.ok(measured[1]<measured[0]*2.4,`expected near-linear charged work: ${measured}`);
});

for(const reverse of[false,true])for(const count of[50,65,66,70])test(`${count} Nest modules preserve the same depth limit ${reverse?'leaf-first':'root-first'}`,async t=>{
 const {workspace}=await fixture(t,chain(count,reverse));
 if(count<=65)assert.doesNotThrow(()=>providerLifetimes(workspace));
 else assert.throws(()=>providerLifetimes(workspace),/Nest module recursion limit exceeded/);
});
for(const reverse of[false,true])test(`a bounded Nest import cycle terminates ${reverse?'leaf-first':'root-first'}`,async t=>{
 const {workspace}=await fixture(t,chain(8,reverse,true));assert.doesNotThrow(()=>providerLifetimes(workspace));
});
for(const reverse of[false,true])test(`Nest module-depth exhaustion is incomplete in a public audit ${reverse?'warm':'cold'}`,async t=>{
 const {root}=await fixture(t,chain(70,reverse));const report=await runAudit(root);
 assert.equal(report.complete,false);assert.equal(report.detectors.find(d=>d.name==='detectPerRequestClients').status,'failed');
 assert.equal(report.detectors.find(d=>d.name==='detectPerRequestClients').reason,'Nest module recursion limit exceeded');
});

test('own metadata caches preserve inherited constructor and property injection',async t=>{
 const source=`import{Injectable,Inject,Module,Scope}from'@nestjs/common';import{REQUEST}from'@nestjs/core';
 @Injectable()class Base{constructor(@Inject(REQUEST) request){}@Inject('shared') shared;}
 @Injectable()class Child extends Base{}
 @Injectable({scope:Scope.REQUEST})class RequestDependency{}
 @Injectable()class PropertyBase{@Inject(RequestDependency) dependency;}
 @Injectable()class PropertyChild extends PropertyBase{}
 @Injectable()class OwnConstructor extends Base{constructor(){super({})}}
 @Module({providers:[Child,PropertyChild,OwnConstructor,RequestDependency,{provide:'shared',useValue:{}}]})class App{}`;
 const {workspace}=await fixture(t,{'main.ts':source});const lifetimes=providerLifetimes(workspace);const byName=new Map([...lifetimes].filter(([node])=>ts.isClassDeclaration(node)).map(([node,value])=>[node.name.text,value.kind]));
 assert.equal(byName.get('Child'),'request');assert.equal(byName.get('PropertyChild'),'request');assert.equal(byName.get('OwnConstructor'),'singleton');
});

test('failed member indexing cannot publish partial metadata on retry',async t=>{
 const {workspace}=await fixture(t,{'main.ts':`class Base{${Array.from({length:200},(_,i)=>`field${i}=1;`).join('')}}class Child extends Base{}`});
 const take=AnalysisBudget.prototype.take;
 try{for(let attempt=0;attempt<2;attempt++){let remaining=25;AnalysisBudget.prototype.take=function(n=1){if(this.label==='Nest lifetime'&&(remaining-=n)<0)throw new AnalysisLimitError('forced Nest lifetime analysis work budget exceeded');return take.call(this,n)};assert.throws(()=>providerLifetimes(workspace),/forced Nest lifetime analysis work budget exceeded/);}}finally{AnalysisBudget.prototype.take=take;}
 assert.doesNotThrow(()=>providerLifetimes(workspace));
});

test('Nest member work exhaustion keeps public audits strict',async t=>{
 const {root}=await fixture(t,{'main.ts':`class Base{${Array.from({length:200},(_,i)=>`field${i}=1;`).join('')}}class Child extends Base{}`});const take=AnalysisBudget.prototype.take;let remaining=25;
 AnalysisBudget.prototype.take=function(n=1){if(this.label==='Nest lifetime'&&(remaining-=n)<0)throw new AnalysisLimitError('forced Nest lifetime analysis work budget exceeded');return take.call(this,n)};
 try{const report=await runAudit(root);assert.equal(report.complete,false);assert.equal(report.detectors.find(d=>d.name==='detectPerRequestClients').status,'failed');}finally{AnalysisBudget.prototype.take=take;}
});
