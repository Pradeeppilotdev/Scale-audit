import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';
async function audit(files,verify){
 const root=await mkdtemp(path.join(tmpdir(),'scale-di-review-'));
 try {for(const[file,source]of Object.entries(typeof files==='string'?{'route.ts':files}:files)){
  await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),source);
 }const report=await runAudit(root);assert.equal(report.complete,true);await verify(report);
 }finally{await rm(root,{recursive:true,force:true});}
}
const repeated=report=>report.findings.filter(f=>f.id==='per-request-client');
const db="import {Pool} from 'pg';class Database{pool=new Pool();}";
for(const api of ['tsyringe','awilix'])for(const condition of ['false','true','runtimeFlag'])test(`${api} ${condition} singleton replacement respects branch execution`,async()=>{
 const setup=api==='tsyringe'?"import {container as c} from 'tsyringe';":"import {createContainer,asClass} from 'awilix';const c=createContainer();";
 const transient=api==='tsyringe'?"c.register(Database,{useClass:Database});":"c.register({db:asClass(Database)});";
 const singleton=api==='tsyringe'?"c.registerSingleton(Database);":"c.register({db:asClass(Database).singleton()});";
 const resolve=api==='tsyringe'?'c.resolve(Database)':"c.resolve('db')";
 await audit(`${setup}${db}const runtimeFlag=Boolean(process.env.SHARED);${transient}if(${condition}){${singleton}}export function GET(req,res){return ${resolve};}`,r=>assert.equal(repeated(r).length,condition==='true'?0:1));
});
test('a statically selected else branch can replace the earlier transient registration',async()=>{
 await audit(`import {container} from 'tsyringe';${db}container.register(Database,{useClass:Database});if(false){container.register(Database,{useClass:Database});}else{container.registerSingleton(Database);}export const GET=()=>container.resolve(Database);`,r=>assert.equal(repeated(r).length,0));
});
test('an unknown transient branch remains a possible per-request allocation',async()=>{
 await audit(`import {container} from 'tsyringe';${db}container.registerSingleton(Database);if(process.env.TRANSIENT){container.register(Database,{useClass:Database});}export const GET=()=>container.resolve(Database);`,r=>assert.equal(repeated(r).length,1));
});
for(const inheritance of ['constructor','property'])test(`Nest inherited ${inheritance} injection propagates request scope across files`,async()=>{
 const injected=inheritance==='constructor'?'constructor(@Inject(Context)context:Context){}':'@Inject(Context)context:Context;';
 await audit({
  'context.ts':"import {Injectable,Scope} from '@nestjs/common';@Injectable({scope:Scope.REQUEST})export class Context{}",
  'base.ts':`import {Injectable,Inject} from '@nestjs/common';import {Context} from './context.js';@Injectable()export class Base{${injected}}`,
  'route.ts':"import {Module,Injectable} from '@nestjs/common';import {Pool} from 'pg';import {Base} from './base.js';import {Context} from './context.js';@Injectable()class Database extends Base{pool=new Pool();}@Module({providers:[Context,Database]})class App{}",
 },r=>assert.equal(repeated(r).length,1));
});
test('a subclass own constructor replaces inherited Nest constructor dependencies',async()=>{
 await audit("import {Module,Injectable,Inject,Scope} from '@nestjs/common';import {Pool} from 'pg';@Injectable({scope:Scope.REQUEST})class Context{}@Injectable()class Base{constructor(@Inject(Context)context:Context){}}@Injectable()class Database extends Base{constructor(){super(undefined);}pool=new Pool();}@Module({providers:[Context,Database]})class App{}",r=>assert.equal(repeated(r).length,0));
});
test('inherited singleton Nest dependency stays shared',async()=>{
 await audit("import {Module,Injectable,Inject} from '@nestjs/common';import {Pool} from 'pg';@Injectable()class Context{}@Injectable()class Base{constructor(@Inject(Context)context:Context){}}@Injectable()class Database extends Base{pool=new Pool();}@Module({providers:[Context,Database]})class App{}",r=>assert.equal(repeated(r).length,0));
});
for(const enabled of [true,false])test(`TSyringe compiler metadata inference respects emitDecoratorMetadata ${enabled}`,async()=>{
 await audit({
  'tsconfig.json':JSON.stringify({compilerOptions:{experimentalDecorators:true,emitDecoratorMetadata:enabled}}),
  'route.ts':`import {container,injectable} from 'tsyringe';${db}@injectable()class Service{constructor(db:Database){}}container.register(Database,{useClass:Database});export const GET=()=>container.resolve(Service);`,
 },r=>assert.equal(repeated(r).length,enabled?1:0));
});
test('TSyringe explicit inject is followed with compiler metadata disabled',async()=>{
 await audit({
  'tsconfig.json':JSON.stringify({compilerOptions:{experimentalDecorators:true,emitDecoratorMetadata:false}}),
  'route.ts':`import {container,injectable,inject} from 'tsyringe';${db}@injectable()class Service{constructor(@inject(Database)db:Database){}}container.register(Database,{useClass:Database});export const GET=()=>container.resolve(Service);`,
 },r=>assert.equal(repeated(r).length,1));
});

test('mutated let conditions do not prove a replacement branch dead or unconditional',async()=>{
 await audit(`import {container} from 'tsyringe';${db}let enabled=false;container.registerSingleton(Database);enabled=true;if(enabled){container.register(Database,{useClass:Database});}export const GET=()=>container.resolve(Database);`,r=>assert.equal(repeated(r).length,1));
 await audit(`import {container} from 'tsyringe';${db}let enabled=true;container.register(Database,{useClass:Database});enabled=false;if(enabled){container.registerSingleton(Database);}export const GET=()=>container.resolve(Database);`,r=>assert.equal(repeated(r).length,1));
});
test('immutable boolean aliases can prove singleton registration executes',async()=>{
 await audit(`import {container} from 'tsyringe';${db}const enabled=true;container.register(Database,{useClass:Database});if(enabled){container.registerSingleton(Database);}export const GET=()=>container.resolve(Database);`,r=>assert.equal(repeated(r).length,0));
});

for(const api of ['tsyringe','awilix'])test(`${api} definite later startup write supersedes earlier conditional alternative`,async()=>{
 const setup=api==='tsyringe'?"import {container as c} from 'tsyringe';":"import {createContainer,asClass} from 'awilix';const c=createContainer();";
 const transient=api==='tsyringe'?"c.register(Database,{useClass:Database});":"c.register({db:asClass(Database)});";
 const singleton=api==='tsyringe'?"c.registerSingleton(Database);":"c.register({db:asClass(Database).singleton()});";
 const resolve=api==='tsyringe'?'c.resolve(Database)':"c.resolve('db')";
 await audit(`${setup}${db}if(process.env.TRANSIENT){${transient}}${singleton}export const GET=()=>${resolve};`,r=>assert.equal(repeated(r).length,0));
});
test('TSyringe resolveAll keeps a conditional earlier registration after a definite later registration',async()=>{
 await audit(`import {container} from 'tsyringe';${db}if(process.env.TRANSIENT){container.register(Database,{useClass:Database});}container.registerSingleton(Database);export const GET=()=>container.resolveAll(Database);`,r=>assert.equal(repeated(r).length,1));
});

test('mutable alias cannot inherit immutable branch proof from its initializer',async()=>{
 await audit(`import {container} from 'tsyringe';${db}const original=true;let enabled=original;enabled=false;container.register(Database,{useClass:Database});if(enabled){container.registerSingleton(Database);}export const GET=()=>container.resolve(Database);`,r=>assert.equal(repeated(r).length,1));
});

test('Nest constructor overloads read injection from the implementation',async()=>{
 await audit("import {Module,Injectable,Inject,Scope} from '@nestjs/common';import {Pool} from 'pg';@Injectable({scope:Scope.REQUEST})class Context{}@Injectable()class Database{constructor(ctx:unknown);constructor(@Inject(Context)ctx:unknown){}pool=new Pool();}@Module({providers:[Context,Database]})class App{}",r=>assert.equal(repeated(r).length,1));
});
test('Nest inherited overloaded constructor reads the decorated implementation',async()=>{
 await audit("import {Module,Injectable,Inject,Scope} from '@nestjs/common';import {Pool} from 'pg';@Injectable({scope:Scope.REQUEST})class Context{}@Injectable()class Base{constructor(ctx:unknown);constructor(@Inject(Context)ctx:unknown){}}@Injectable()class Database extends Base{pool=new Pool();}@Module({providers:[Context,Database]})class App{}",r=>assert.equal(repeated(r).length,1));
});
