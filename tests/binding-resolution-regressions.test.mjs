import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import ts from 'typescript';
import {runAudit} from '../dist/runner.js';
import {SourceProject} from '../dist/project.js';

async function fixture(files,verify){
 const root=await mkdtemp(path.join(tmpdir(),'scale-binding-regression-'));
 try{
  for(const[file,text]of Object.entries(files)){
   await mkdir(path.dirname(path.join(root,file)),{recursive:true});
   await writeFile(path.join(root,file),text);
  }
  await verify(root);
 }finally{await rm(root,{recursive:true,force:true});}
}
const database="import {Pool} from 'pg';export class Database{pool=new Pool();}";
const route=specifier=>`import {container} from 'tsyringe';import {Database} from '${specifier}';container.register(Database,{useClass:Database});export function GET(req,res){return container.resolve(Database);}`;
const connections=report=>report.findings.filter(f=>f.id==='per-request-client');

for(const extension of ['.tsx','.js','.jsx','.mts','.cts','.mjs','.cjs'])test(`direct ${extension} module precedes directory index.ts`,async()=>{
 await fixture({},async root=>{
  const files=['route.ts','db'+extension,'db/index.ts'];
  const project=await SourceProject.create(root,files.map(rel=>({rel,sf:ts.createSourceFile(rel,'',ts.ScriptTarget.Latest,true)})));
  assert.equal(project.resolve('route.ts','./db'),'db'+extension);
 });
});

test('extensionless module resolution preserves a real cross-file pool finding',async()=>{
 await fixture({'db.tsx':database,'db/index.ts':'export class Database{}','route.ts':route('./db')},async root=>{
  const report=await runAudit(root);
  assert.equal(report.complete,true);
  assert.equal(connections(report).length,1);
  assert.equal(connections(report)[0].file,'db.tsx');
 });
});

test('directory index and runtime-extension substitution remain supported',async()=>{
 await fixture({},async root=>{
  const files=['route.ts','db/index.ts','other.tsx','other.js','esm.mts','cjs.cts'];
  const project=await SourceProject.create(root,files.map(rel=>({rel,sf:ts.createSourceFile(rel,'',ts.ScriptTarget.Latest,true)})));
  assert.equal(project.resolve('route.ts','./db'),'db/index.ts');
  assert.equal(project.resolve('route.ts','./other.js'),'other.tsx');
  assert.equal(project.resolve('route.ts','./esm.mjs'),'esm.mts');
  assert.equal(project.resolve('route.ts','./cjs.cjs'),'cjs.cts');
 });
});

for(const depth of [20,140])test(`a ${depth}-barrel identity chain is analyzed or explicitly incomplete`,async()=>{
 const files={'db.ts':database,'route.ts':route(`./barrel${depth-1}.js`),
  'outbound.ts':"export async function GET(){return fetch('https://example.com');}"};
 for(let i=0;i<depth;i++)files[`barrel${i}.ts`]=`export {Database} from './${i?'barrel'+(i-1):'db'}.js';`;
 await fixture(files,async root=>{
  const report=await runAudit(root);
  assert.equal(report.coverage.analyzed,depth+3);
  assert.ok(report.findings.some(f=>f.id==='outbound-no-timeout'));
  if(depth===20){assert.equal(report.complete,true);assert.equal(connections(report).length,1);}
  else{
   assert.equal(report.complete,false);
   assert.ok(report.detectors.some(d=>d.status==='failed'&&d.reason==='Binding resolution depth limit exceeded'));
  }
 });
});

test('genuine re-export cycles stay unknown without exhausting the depth limit',async()=>{
 await fixture({'a.ts':"export {Database} from './b.js';",'b.ts':"export {Database} from './a.js';",'route.ts':route('./a.js')},async root=>{
  const report=await runAudit(root);
  assert.equal(report.complete,true);
  assert.ok(report.detectors.every(d=>d.status==='complete'));
  assert.equal(connections(report).length,0);
 });
});


test('JavaScript extension substitution and direct-file order agree with TypeScript',async()=>{
 await fixture({},async root=>{
  const variants=[
   {files:['db.ts','db.tsx','db.js','db.jsx'],specifier:'./db'},
   {files:['db.tsx','db.js','db.jsx'],specifier:'./db.js'},
   {files:['db.jsx'],specifier:'./db.js'},
   {files:['db.ts','db.jsx','db.js'],specifier:'./db.jsx'},
   {files:['db.js','db.mts'],specifier:'./db'},
  ];
  for(const{files,specifier}of variants){
   const project=await SourceProject.create(root,['route.ts',...files].map(rel=>({rel,sf:ts.createSourceFile(rel,'',ts.ScriptTarget.Latest,true)})));
   const host={fileExists:file=>files.some(rel=>file===`/repo/${rel}`),readFile:()=>'',directoryExists:()=>true,getCurrentDirectory:()=>'/repo',realpath:file=>file};
   const expected=ts.resolveModuleName(specifier,'/repo/route.ts',{moduleResolution:ts.ModuleResolutionKind.Node10,allowJs:true},host).resolvedModule?.resolvedFileName.slice('/repo/'.length);
   assert.equal(project.resolve('route.ts',specifier),expected);
  }
 });
});
