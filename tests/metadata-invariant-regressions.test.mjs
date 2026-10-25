import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import {symbolOf} from '../dist/bindings.js';
import {runAudit} from '../dist/runner.js';

function initializer(source){
 const sf=ts.createSourceFile('invariant.ts',source,ts.ScriptTarget.Latest,true);
 const statement=sf.statements[sf.statements.length-1];
 return statement.declarationList.declarations[0].initializer;
}
for(const global of ['AbortSignal','Promise','JSON','Math'])test(`noLib identity invariant distinguishes native ${global} from local shadow`,()=>{
 assert.equal(symbolOf(initializer(`const ref=${global};`)),undefined);
 const local=initializer(`const ${global}={};const ref=${global};`);
 const symbol=symbolOf(local);
 assert.ok(symbol?.declarations?.some(ts.isVariableDeclaration));
});

async function audit(config,explicit,verify){
 const root=await mkdtemp(path.join(tmpdir(),'scale-metadata-invariant-'));
 try {
  if(config!==undefined)await writeFile(path.join(root,'tsconfig.json'),JSON.stringify(config));
  await writeFile(path.join(root,'route.ts'),`import {container,injectable,inject} from 'tsyringe';import {Pool} from 'pg';@injectable()class Database{pool=new Pool();}@injectable()class Service{constructor(${explicit?'@inject(Database) ':''}database:Database){}}container.register(Database,{useClass:Database});export const GET=()=>container.resolve(Service);`);
  const r=await runAudit(root);assert.equal(r.complete,true);await verify(r.findings.filter(f=>f.id==='per-request-client'));
 }finally{await rm(root,{recursive:true,force:true});}
}
for(const [name,config,expected]of [
 ['no config',undefined,0],
 ['empty config',{},0],
 ['decorators without emitted metadata',{compilerOptions:{experimentalDecorators:true}},0],
 ['metadata disabled',{compilerOptions:{experimentalDecorators:true,emitDecoratorMetadata:false}},0],
 ['metadata enabled',{compilerOptions:{experimentalDecorators:true,emitDecoratorMetadata:true}},1],
])test(`TSyringe inferred dependencies require explicit emitted metadata: ${name}`,()=>audit(config,false,findings=>assert.equal(findings.length,expected)));
for(const [name,config]of [['no config',undefined],['metadata disabled',{compilerOptions:{experimentalDecorators:true,emitDecoratorMetadata:false}}]])test(`TSyringe explicit injection survives ${name}`,()=>audit(config,true,findings=>assert.equal(findings.length,1)));
