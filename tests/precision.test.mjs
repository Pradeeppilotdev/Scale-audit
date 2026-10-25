import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runAudit } from '../dist/runner.js';
import { planCodemod } from '../dist/codemod.js';

async function audit(source, verify, options={}, file='route.ts') {
  const root=await mkdtemp(path.join(tmpdir(),'scale-precision-'));
  try {await writeFile(path.join(root,file),source);await verify(await runAudit(root,options),root);}
  finally{await rm(root,{recursive:true,force:true});}
}
const byId=(r,id)=>r.findings.filter(f=>f.id===id);

test('local fetch and axios bindings produce no HTTP findings or safe automatic patches', async()=>{
  for(const source of [
    "function fetch(value) { return value; }\nfetch('local');",
    "function work(fetch) { fetch('local'); }",
    "const axios={get(value){return value;}};\naxios.get('local');",
  ]) await audit(source,(r,root)=>{
    assert.equal(r.findings.length,0);
    // Planner independently rejects stale or externally supplied false findings.
    const line=source.includes('\n')?2:1;
    const plan=planCodemod(root,[{id:'outbound-no-timeout',file:'route.ts',line}]);
    assert.equal(plan.files.length,0);
  },{codemod:'diff'});
});

test('scoped initializer resolution cannot cycle through unrelated function locals',async()=>{
  await audit(`const a=[1]; const b=[2];
function first(){const a=b; return a;}
function second(){const b=a; return b;}
async function work(){await Promise.all(a.map(async x=>x));}`,r=>assert.equal(byId(r,'unbounded-concurrency').length,0));
  await audit(`let a=b; let b=a; async function work(){await Promise.all(a.map(async x=>x));}`,r=>assert.ok(r.coverage.analyzed===1));
});

test('offsets, cursors, disabled limits, groupBy and collection aggregates remain unbounded',async()=>{
  await audit([
    "prisma.user.findMany({skip:10});",
    "prisma.user.findMany({cursor:{id:1}});",
    "prisma.user.findMany({take:0});",
    "prisma.user.groupBy({by:['email']});",
    "import mongoose from 'mongoose'; const Post=mongoose.model('Post',{});",
    "Post.aggregate([]);",
    "Post.find().skip(10).limit(0);",
    "prisma.user.findMany({take:10});",
    "prisma.user.aggregate({_count:true});",
    "prisma.user.findMany({...options});",
    "prisma.user.findMany({take:10,...options});",
  ].join('\n'),r=>{
    const findings=byId(r,'unbounded-read');
    assert.deepEqual(findings.map(f=>f.line).sort((a,b)=>a-b),[1,2,3,4,6,7,10,11]);
    for(const line of [10,11])assert.equal(findings.find(f=>f.line===line).confidence,'low');
  });
});

test('SQL handles comments, literals, scalar aggregates, writes and nested limits',async()=>{
  const queries=[
    'SELECT COUNT(*) FROM users',
    'UPDATE users SET active=false',
    'SELECT * FROM users /* LIMIT 10 */',
    "SELECT 'LIMIT 10' FROM users",
    'SELECT * FROM (SELECT * FROM users LIMIT 10) u',
    'SELECT * FROM users LIMIT 10',
    "SELECT '--' FROM users LIMIT 10",
    'SELECT COUNT(*) FROM users UNION SELECT id FROM users',
    'UPDATE users SET active=false RETURNING *',
    'SELECT email, COUNT(*) FROM users GROUP BY email',
  ];
  await audit(queries.map(q=>`client.query(${JSON.stringify(q)});`).join('\n'),r=>{
    assert.deepEqual(byId(r,'unbounded-raw-query').map(f=>f.line),[3,4,5,8,9,10]);
  });
});

test('query builders and terminal all reads are covered while literal caps are honored',async()=>{
  await audit([
    'db.select().from(users);',
    'db.select().from(users).limit(10);',
    'db.orm.public.User.all();',
    'db.orm.public.User.limit(10).all();',
  ].join('\n'),r=>assert.deepEqual(byId(r,'unbounded-read').map(f=>f.line),[1,3]));
});

test('ESM and CommonJS aliases preserve HTTP, sync-I/O and connection-client detection',async()=>{
  await audit([
    "import httpClient from 'axios';",
    "import {readFileSync as read} from 'node:fs';",
    "import {createPool as pool} from 'mysql2';",
    "const {readFileSync:readCjs}=require('node:fs');",
    "export function GET(req,res){\nhttpClient.get('url');\nread('x');\nreadCjs('x');\nreturn pool({}); }",
  ].join('\n'),r=>{
    assert.equal(byId(r,'outbound-no-timeout').length,1);
    assert.equal(byId(r,'sync-io').length,2);
    assert.equal(byId(r,'per-request-client').length,1);
  });
});

test('ordinary method pool assignment is flagged; constructor initialization and local Client classes are not',async()=>{
  await audit([
    "import {Pool} from 'pg';",
    "class Handler { constructor(){this.pool=new Pool();} handle(req,res){this.pool=new Pool();} }",
    "class Client {}",
    "function GET(req,res){return new Client();}",
  ].join('\n'),r=>{
    assert.equal(byId(r,'per-request-client').length,1);
    assert.equal(byId(r,'per-request-client')[0].line,2);
  });
});

test('limiter proof uses returned limiter calls, not matching substrings',async()=>{
  await audit([
    "import pLimit from 'p-limit'; const limit=pLimit(5);",
    "async function work(items){await Promise.all(items.map(item=>sendUnlimited(item)));}",
    "async function bounded(items){await Promise.all(items.map(item=>limit(()=>send(item))));}",
    "async function ignored(items){await Promise.all(items.map(item=>{limit(()=>{});return send(item);}));}",
  ].join('\n'),r=>assert.deepEqual(byId(r,'unbounded-concurrency').map(f=>f.line),[2,4]));
});

test('returned database promises still count as N+1 work',async()=>{
  await audit("async function work(users){return Promise.all(users.map(user=>prisma.post.findMany({where:{userId:user.id},take:10})));}",r=>assert.equal(byId(r,'n-plus-one').length,1));
});

test('spread store configs are uncertain and property rejection handlers are recognized',async()=>{
  await audit("import session from 'express-session';\nsession({...options});\nPromise.reject('fail').then(()=>{},handlers.onError);",r=>{
    assert.equal(byId(r,'in-process-session')[0].confidence,'low');
    assert.equal(byId(r,'unhandled-rejection').length,0);
  });
});


test('timeout fixes cannot call a shadowed AbortSignal',async()=>{
  await audit("const AbortSignal={};\nfetch('https://example.com');",r=>{
    assert.equal(byId(r,'outbound-no-timeout').length,1);
    assert.equal(r.codemod.edits.length,0);
    assert.equal(r.codemod.files.length,0);
  },{codemod:'apply'});
});

test('new builder recognition does not classify UI selects in ORM files as database reads',async()=>{
  await audit("import {PrismaClient} from '@prisma/client';\nui.select().from(options);\ncollection.all();",r=>assert.equal(byId(r,'unbounded-read').length,0));
});


test('binding validation also protects JavaScript inputs',async()=>{
  const source="function fetch(value) { return value; }\nfetch('local');";
  await audit(source,r=>{
    assert.equal(r.findings.length,0);
    assert.equal(r.codemod.edits.length,0);
  },{codemod:'apply'},'route.js');
});
