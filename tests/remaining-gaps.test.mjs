import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runAudit } from '../dist/runner.js';

async function audit(source, verify, {files={}, file='route.ts', ...options}={}) {
  const root=await mkdtemp(path.join(tmpdir(),'scale-remaining-'));
  try {
    for(const [name,content] of Object.entries({...files,[file]:source})) {
      await mkdir(path.dirname(path.join(root,name)),{recursive:true});
      await writeFile(path.join(root,name),content);
    }
    await verify(await runAudit(root,options),root);
  } finally {await rm(root,{recursive:true,force:true});}
}
const findings=(r,id)=>r.findings.filter(f=>f.id===id);

test('pagination uses the final cap and never interprets filter columns as options',async()=>{
  await audit([
    "import mongoose from 'mongoose'; const User=mongoose.model('User',{});",
    'User.find({limit:10});',
    'User.find({},null,{limit:10});',
    'User.find().limit(10).limit(0);',
    'User.find().limit(0).limit(10);',
    'prisma.user.findMany({take:10,take:undefined});',
    'prisma.user.findMany({take:undefined,take:10});',
    'prisma.user.findMany({take:10,...options});',
    'prisma.user.findMany({...options,take:10});',
  ].join('\n'),r=>{
    assert.deepEqual(findings(r,'unbounded-read').map(f=>f.line).sort((a,b)=>a-b),[2,4,6,8]);
    assert.equal(findings(r,'unbounded-read').find(f=>f.line===8).confidence,'low');
  });
});

test('MongoDB and TypeORM retain their own find option positions',async()=>{
  await audit("import {MongoClient} from 'mongodb';\ndb.users.find({limit:10});\ndb.users.find({}, {limit:10});",r=>assert.deepEqual(findings(r,'unbounded-read').map(f=>f.line),[2]));
  await audit("import {Repository} from 'typeorm';\nrepo.find({take:10});",r=>assert.equal(findings(r,'unbounded-read').length,0));
});

test('every SQL statement needs its own bounds; quoted semicolons do not split statements',async()=>{
  const sql=[
    'SELECT * FROM users LIMIT 10; SELECT * FROM secrets',
    'SELECT COUNT(*) FROM users; SELECT * FROM secrets',
    'SELECT * FROM users; SELECT * FROM secrets LIMIT 10',
    'SELECT * FROM users LIMIT 10; SELECT * FROM secrets LIMIT 20;',
    "SELECT ';' FROM users LIMIT 10",
    'UPDATE users SET active=false; SELECT * FROM secrets',
  ];
  await audit(sql.map(q=>`client.query(${JSON.stringify(q)});`).join('\n'),r=>assert.deepEqual(findings(r,'unbounded-raw-query').map(f=>f.line),[1,2,3,6]));
});

test('bare rejections and ineffective catch handlers are reported, real handlers and consumed promises are not',async()=>{
  await audit([
    "Promise.reject('boom');",
    "fetch('url').catch(undefined);",
    "fetch('url').catch();",
    "Promise.reject('boom').catch(null);",
    "Promise.reject('boom').catch(()=>{});",
    "Promise.reject('boom').catch(handlers.error);",
    "async function f(){return Promise.reject('boom');}",
    "async function g(){await Promise.reject('boom');}",
    "function local(Promise){Promise.reject('local');}",
  ].join('\n'),r=>assert.deepEqual(findings(r,'unhandled-rejection').map(f=>f.line),[1,2,3,4]));
});

test('pool guards only exempt shared module bindings, not request-local bindings or else branches',async()=>{
  await audit([
    "import {Pool} from 'pg'; let shared; let another;",
    'function first(req,res){if(!shared)shared=new Pool();return shared;}',
    'function second(req,res){another ??= new Pool();return another;}',
    'function fresh(req,res){let pool;if(!pool)pool=new Pool();return pool;}',
    'function wrongBranch(req,res){if(!shared){}else shared=new Pool();}',
  ].join('\n'),r=>assert.deepEqual(findings(r,'per-request-client').map(f=>f.line),[4,5]));
});

test('constructing pool-owning classes inside requests makes constructor and field pools per-call',async()=>{
  await audit([
    "import {Pool} from 'pg';",
    'class Handler{constructor(){this.pool=new Pool();}}',
    'class FieldHandler{pool=new Pool();}',
    'function GET(req,res){return new Handler();}',
    'function POST(req,res){return new FieldHandler();}',
  ].join('\n'),r=>assert.deepEqual(findings(r,'per-request-client').map(f=>f.line),[2,3]));
});

test('deferred functions inside loops are not N+1 work; invoked callbacks and IIFEs remain covered',async()=>{
  await audit([
    'for(const id of ids){function deferred(){return prisma.user.findUnique({where:{id}});} callbacks.push(deferred);}',
    'const callbacks=ids.map(id=>()=>prisma.user.findUnique({where:{id}}));',
    'const work=ids.map(id=>prisma.user.findUnique({where:{id}}));',
    'async function load(){for(const id of ids){await (async()=>await prisma.user.findUnique({where:{id}}))();}}',
  ].join('\n'),r=>assert.deepEqual(findings(r,'n-plus-one').map(f=>f.line),[3,4]));
});

test('Axios utilities are not HTTP calls and namespace/global fetch calls retain timeout detection',async()=>{
  await audit([
    "import {isAxiosError} from 'axios';",
    "import * as undici from 'undici';",
    'const yes=isAxiosError(err);',
    "undici.fetch('https://example.com');",
    "globalThis.fetch('https://example.com');",
    "function local(globalThis){globalThis.fetch('local');}",
  ].join('\n'),r=>assert.deepEqual(findings(r,'outbound-no-timeout').map(f=>f.line),[4,5]));
});

test('a CLI Map named app does not become a request entry',async()=>{
  await audit("#!/usr/bin/env node\nimport fs from 'node:fs'; const app=new Map();\nfunction main(){app.get('config');return fs.readFileSync('x');}",r=>assert.equal(findings(r,'sync-io')[0].severity,'info'),{file:'cli.ts'});
});

test('nested scalar and logical filters are checked without treating relation objects as scalar columns',async()=>{
  const schema='model User {\n id Int @id\n email String\n age Int\n posts Post[]\n}\nmodel Post {\n id Int @id\n userId Int\n}';
  await audit([
    "prisma.user.findMany({where:{email:{equals:'x'}},take:10});",
    "prisma.user.findMany({where:{AND:[{email:'x'},{OR:[{age:{gt:18}},{email:'y'}]}]},take:10});",
    "prisma.user.findMany({where:{posts:{some:{userId:1}}},take:10});",
    "prisma.user.findMany({where:{id:{in:[1,2]}},take:10});",
  ].join('\n'),r=>{
    const f=findings(r,'missing-index');
    assert.equal(f.length,3);
    assert.deepEqual(f.map(v=>v.line),[1,2,2]);
    assert.ok(f.every(v=>!/posts/.test(v.message)));
  },{files:{'prisma/schema.prisma':schema}});
});

test('fail-on rejects inherited object keys and valid severity thresholds still fail CI',async()=>{
  await audit("fetch('url');",(_,root)=>{
    for(const threshold of ['toString','constructor','__proto__']){
      const result=spawnSync(process.execPath,['dist/cli.js',root,'--fail-on',threshold],{encoding:'utf8'});
      assert.equal(result.status,1);
      assert.match(result.stderr,/unknown --fail-on/);
    }
    assert.equal(spawnSync(process.execPath,['dist/cli.js',root,'--fail-on','medium'],{encoding:'utf8'}).status,2);
  });
});


test('a guard that yields before initialization can still allocate multiple pools',async()=>{
  await audit("import {Pool} from 'pg'; let pool;\nasync function GET(req,res){if(!pool){await ready();pool=new Pool();}return pool;}",r=>assert.equal(findings(r,'per-request-client').length,1));
});
