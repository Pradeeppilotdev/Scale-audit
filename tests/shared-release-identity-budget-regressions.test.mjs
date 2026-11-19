import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import ts from 'typescript';
import {Workspace} from '../dist/workspace.js';
import {AnalysisBudget,AnalysisLimitError,projectWorkLimit} from '../dist/analysisBudget.js';
import {definitionOf,isHttpFetch,isAxiosCall} from '../dist/bindings.js';
import {requestReachability} from '../dist/requestReachability.js';
import {detectPerRequestClients} from '../dist/detectors/perRequestClient.js';
import {runAudit} from '../dist/runner.js';

async function fixture(files,run){
  const root=await mkdtemp(join(tmpdir(),'scale-shared-release-'));
  try{for(const[name,content]of Object.entries(files)){await mkdir(dirname(join(root,name)),{recursive:true});await writeFile(join(root,name),content);}return await run(root,await Workspace.load(root));}
  finally{await rm(root,{recursive:true,force:true});}
}
function calls(sf){const out=[],pending=[sf];while(pending.length){const n=pending.pop();if(ts.isCallExpression(n)||ts.isNewExpression(n))out.push(n);ts.forEachChild(n,c=>{pending.push(c)});}return out;}
async function clients(source,extra={}){return fixture({'route.ts':source,...extra},(root,ws)=>detectPerRequestClients(root,ws));}
function exportSources(count){const names=Array.from({length:count},(_,i)=>`f${i}`);return{'helpers.ts':names.map(n=>`export function ${n}(){}`).join('\n'),'route.ts':`import{${names.join(',')}}from'./helpers';export function GET(){${names.map(n=>`${n}();`).join('')}}`};}

test('ordinary export identities reuse charged syntax across many distinct references',async()=>{
 const work=[];
 for(const count of[300,600,1200])await fixture(exportSources(count),async(_root,ws)=>{
  const helper=ws.units.find(u=>u.rel==='helpers.ts').sf;let visited=0,charged=0;
  const filter=helper.statements.filter;helper.statements.filter=function(callback,...args){return filter.call(this,(...p)=>{visited++;return callback(...p)},...args)};
  const take=AnalysisBudget.prototype.take;AnalysisBudget.prototype.take=function(n=1){if(this.label==='Promise binding writes')charged+=n;return take.call(this,n)};
  try{requestReachability(ws);assert.ok(visited<count*10,`replayed export scans: ${visited}`);assert.ok(charged>=count);assert.ok(charged<projectWorkLimit(ws.units.map(u=>u.sf)));work.push(charged);}
  finally{AnalysisBudget.prototype.take=take;helper.statements.filter=filter;}
 });
 assert.ok(work[1]<work[0]*2.3,String(work));assert.ok(work[2]<work[1]*2.3,String(work));
});

test('a failed ordinary export scan remains failed rather than publishing partial syntax',async()=>{
 await fixture(exportSources(600),async(_root,ws)=>{
  const entry=calls(ws.units.find(u=>u.rel==='route.ts').sf)[0].expression;const take=AnalysisBudget.prototype.take;let scans=0;
  AnalysisBudget.prototype.take=function(n=1){if(this.label==='Promise binding writes'&&new Error().stack.includes('currentModuleExports')&&++scans>50)throw new AnalysisLimitError('Forced export syntax limit');return take.call(this,n)};
  try{for(let attempt=0;attempt<2;attempt++)assert.throws(()=>definitionOf(entry),e=>e instanceof AnalysisLimitError&&e.message==='Forced export syntax limit');}
  finally{AnalysisBudget.prototype.take=take;}
  assert.ok(scans>51);assert.ok(ts.isFunctionDeclaration(definitionOf(entry)));
 });
});
for(const warm of[false,true])test(`${warm?'warm':'cold'} export syntax caches retain binding depth exhaustion`,async()=>{
 const files={'route.ts':"import{value}from'./barrel0';value();",'warm.ts':"import{value}from'./barrel100';value();"};for(let i=0;i<140;i++)files[`barrel${i}.ts`]=i===139?'export function value(){}':`export{value}from'./barrel${i+1}';`;
 await fixture(files,async(_root,ws)=>{
  if(warm){const target=calls(ws.units.find(u=>u.rel==='warm.ts').sf)[0].expression;const declaration=definitionOf(target);assert.ok(ts.isFunctionDeclaration(declaration));assert.ok(declaration.getSourceFile().fileName.endsWith('barrel139.ts'));}
  assert.throws(()=>definitionOf(calls(ws.units.find(u=>u.rel==='route.ts').sf)[0].expression),e=>e instanceof AnalysisLimitError&&/depth limit/.test(e.message));
 });
});

for(const [title,header]of[
 ['default',"import pg from 'pg';"],['namespace',"import * as pg from 'pg';"],['CommonJS',"const pg=require('pg');"],
])for(const[label,setup,callee,expected]of[
 ['direct','','pg.Pool',1],['destructured','const{Pool}=pg;','Pool',1],['renamed destructuring','const{Pool:Db}=pg;','Db',1],
 ['member alias','const Db=pg.Pool;','Db',1],['member replacement','pg.Pool=class{};','pg.Pool',0],
 ['captured before replacement','const Db=pg.Pool;pg.Pool=class{};','Db',1],
 ['captured after replacement','pg.Pool=class{};const Db=pg.Pool;','Db',0],
 ['restored member','const Native=pg.Pool;pg.Pool=class{};pg.Pool=Native;','pg.Pool',1],
 ['other member','pg.other=()=>{};','pg.Pool',1],
 ['member alias replacement','const alias=pg;alias.Pool=class{};','pg.Pool',0],
 ['local replacement is separate','let alias=pg;alias={};alias.Pool=class{};','pg.Pool',1],
 ['conditional alias may replace member','let alias=pg;if(flag)alias={};alias.Pool=class{};','pg.Pool',0],
 ['inverse conditional alias','let alias={};if(flag)alias=pg;alias.Pool=class{};','pg.Pool',0],
 ['descriptor replacement',"Object.defineProperty(pg,'Pool',{value:class{}});",'pg.Pool',0],
 ['Reflect replacement',"Reflect.set(pg,'Pool',class{});",'pg.Pool',0],
 ['opaque object mutation','Object.assign(pg,replacements);','pg.Pool',0],
 ['captured before descriptor','const Db=pg.Pool;Object.defineProperty(pg,"Pool",{value:class{}});','Db',1],
 ['computed write','pg[key]=class{};','pg.Pool',0],['member deletion','delete pg.Pool;','pg.Pool',0],
 ['object escape','const holder={pg};holder.pg.Pool=class{};','pg.Pool',0],
 ['array escape','const holder=[pg];holder[0].Pool=class{};','pg.Pool',0],
])test(`${title} client identity: ${label}`,async()=>{
 assert.equal((await clients(`${header}${setup}export function GET(){return new ${callee}();}`)).length,expected);
});

for(const[label,bridge,entry,expected]of[
 ['default namespace','export default pg;','import db from "./bridge";new db.Pool()',1],
 ['mutated exported namespace','pg.Pool=class{};export default pg;','import db from "./bridge";new db.Pool()',0],
 ['captured constructor export','export const Db=pg.Pool;pg.Pool=class{};','import{Db}from"./bridge";new Db()',1],
 ['replacement before constructor export','pg.Pool=class{};export const Db=pg.Pool;','import{Db}from"./bridge";new Db()',0],
])test(`client member identity survives ${label}`,async()=>{
 const[imports,call]=entry.split(';');assert.equal((await clients(`${imports};export function GET(){return ${call};}`,{'bridge.ts':`import pg from'pg';${bridge}`})).length,expected);
});

for(const[label,source,expected]of[
 ['native global',"fetch(url)",true],['replaced global',"globalThis.fetch=()=>{};fetch(url)",false],
 ['assigned global',"fetch=()=>{};fetch(url)",false],['captured global',"const saved=fetch;fetch=()=>{};saved(url)",true],
 ['restored global',"const saved=fetch;fetch=()=>{};fetch=saved;fetch(url)",true],
 ['captured before namespace replacement',"import{fetch}from'undici';let send=fetch;const saved=send;send=()=>{};saved(url)",true],
 ['arrow observes final replacement',"import{fetch}from'undici';let send=fetch;export const GET=()=>send(url);send=()=>{}",false],
 ['arrow observes final restoration',"import{fetch}from'undici';let send=()=>{};export const GET=()=>send(url);send=fetch",true],
])test(`HTTP provenance: ${label}`,async()=>{
 await fixture({'route.ts':source},async(_root,ws)=>{const node=calls(ws.units[0].sf).find(n=>n.arguments?.some(a=>ts.isIdentifier(a)&&a.text==='url'));assert.ok(node);assert.equal(isHttpFetch(node.expression),expected);});
});
for(const[label,setup,expected]of[
 ['native','',true],['replaced','axios.get=()=>{};',false],['captured','const saved=axios.get;axios.get=()=>{};',true],
 ['default helper is not HTTP','',false],
])test(`Axios full-member proof: ${label}`,async()=>{
 const callee=label==='captured'?'saved':label==='default helper is not HTTP'?'axios.isCancel':'axios.get';
 await fixture({'route.ts':`import axios from'axios';${setup}${callee}(url);`},async(_root,ws)=>{const node=calls(ws.units[0].sf).find(n=>n.arguments?.some(a=>ts.isIdentifier(a)&&a.text==='url'));assert.equal(isAxiosCall(node.expression),expected);});
});

const clientHeader="import{PrismaClient}from'@prisma/client';let client;";
for(const[name,body,expected]of[
 ['ordinary guard','if(!client){client=new PrismaClient();}',false],
 ['reset before guard','client=undefined;if(!client){client=new PrismaClient();}',true],
 ['reset after guard','if(!client){client=new PrismaClient();}client=undefined;',true],
 ['reset inside guard','if(!client){client=new PrismaClient();client=undefined;}',true],
 ['nullish guard reset','client??=new PrismaClient();client=null;',true],
 ['truthy guard reset','client||=new PrismaClient();client=false;',true],
 ['finally reset','try{client??=new PrismaClient();return client;}finally{client=undefined;}',true],
 ['conditional reset','client??=new PrismaClient();if(flag)client=undefined;',true],
 ['destructured reset','client??=new PrismaClient();({client}={client:undefined});',true],
 ['iteration reset','for(client of values){}client??=new PrismaClient();',true],
 ['restored guard state','if(!client){client=new PrismaClient();client=null;client=new PrismaClient();}',false],
 ['conditional-only restoration','if(!client){client=new PrismaClient();client=null;if(flag)client=new PrismaClient();}',true],
 ['early return before restoration','if(!client){client=new PrismaClient();client=null;if(flag)return;client={};}',true],
 ['truthy later state','client??=new PrismaClient();client={};',false],
 ['different binding reset','client??=new PrismaClient();other=undefined;',false],
])test(`shared client retention: ${name}`,async()=>{
 assert.equal((await clients(`${clientHeader}export function GET(){${body}return client;}`)).length>0,expected);
});
for(const[name,extra,body,expected]of[
 ['startup reset','client=undefined;','',false],
 ['unused reset helper','function reset(){client=undefined;}','',false],
 ['called reset helper','function reset(){client=undefined;}','reset();',true],
])test(`shared client retention accounts for ${name}`,async()=>{
 assert.equal((await clients(`${clientHeader}${extra}export function GET(){${body}client??=new PrismaClient();return client;}`)).length>0,expected);
});
const diHeader="import{PrismaClient}from'@prisma/client';import{container}from'tsyringe';class Db{client=new PrismaClient();}let initialized=false;";
const once="if(!initialized){container.registerSingleton('db',Db);initialized=true;}";
for(const[name,body,expected]of[
 ['ordinary flag',once,false],['outside reset',`${once}initialized=false;`,true],['before reset',`initialized=false;${once}`,true],
 ['finally reset',`try{${once}return container.resolve('db');}finally{initialized=false;}`,true],
 ['conditional outside reset',`${once}if(flag)initialized=false;`,true],
 ['startup-only flags',once,false],
])test(`DI shared flag retention: ${name}`,async()=>{
 const startup=name==='startup-only flags'?'initialized=false;':'';
 assert.equal((await clients(`${diHeader}${startup}export function GET(){${body}return container.resolve('db');}`)).length>0,expected);
});

test('ordinary export work exhaustion is reported as incomplete by the public audit',async()=>{
 await fixture(exportSources(100),async(root)=>{const take=AnalysisBudget.prototype.take;AnalysisBudget.prototype.take=function(n=1){if(this.label==='Promise binding writes')this.remaining=0;return take.call(this,n)};
 try{const report=await runAudit(root);assert.equal(report.complete,false);assert.ok(report.detectors.some(d=>d.status==='failed'&&/budget exceeded/.test(d.reason)));}finally{AnalysisBudget.prototype.take=take;}});
});

for(const depth of[128,512])test(`unrelated ${depth}-deep literal arguments do not exhaust HTTP binding identity`,async()=>{
 const source=`import{Injectable,Scope}from'@nestjs/common';@Injectable(${'('.repeat(depth)}{scope:Scope.REQUEST}${')'.repeat(depth)})class Database{}export async function GET(){return fetch('https://example.test');}`;
 await fixture({'route.ts':source},async(root)=>{const report=await runAudit(root);assert.ok(report.findings.some(f=>f.id==='outbound-no-timeout'));assert.equal(report.detectors.find(d=>d.name==='detectOutboundTimeouts').status,'complete');if(depth===512)assert.equal(report.complete,false);});
});
