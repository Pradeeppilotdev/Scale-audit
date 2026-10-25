import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { scoreFindings } from '../dist/scoring.js';
import { runAudit } from '../dist/runner.js';
import { PREVIEW_SCRIPT } from '../dist/previewUi.js';

async function fixture(work) {
  const root = await mkdtemp(path.join(tmpdir(), 'scale-review-fix-'));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const finding = (id, category, severity, confidence='high') => ({id,category,severity,confidence});
test('scores never improve when findings are added, including confidence ordering and unknown categories', () => {
  const candidates = [];
  for (const category of ['DB','Performance','Other']) for (const severity of ['critical','high','medium','low','info']) {
    for (const confidence of ['high','low']) candidates.push(finding(category,category,severity,confidence));
  }
  for (const a of candidates) for (const b of candidates) {
    assert.ok(scoreFindings([a,b]).score <= scoreFindings([a]).score);
  }
  assert.equal(scoreFindings([]).score,100);
  assert.ok(scoreFindings([finding('a','Performance','low','low')]).score<100);
  assert.equal(scoreFindings([finding('a','DB','critical')]).categories.length,9);
});

test('discarded rejection and finally chains are found, handled and returned chains stay quiet', async () => fixture(async root => {
  await writeFile(path.join(root,'server.ts'), [
    "Promise.reject(new Error('fail')).then(() => {});",
    "Promise.resolve().then(() => { throw new Error('fail'); });",
    "Promise.reject('fail').finally(() => {});",
    "Promise.reject('fail').then(() => {}, undefined);",
    "Promise.reject('fail').then(() => {}).catch(() => {});",
    "Promise.reject('fail').then(() => {}, () => {});",
    "function handled() { return Promise.reject('fail').then(() => {}); }",
    "async function awaited() { await Promise.reject('fail').then(() => {}); }",
    "Promise.reject('fail').then(() => {}, onError);",
  ].join('\n'));
  const r=await runAudit(root);
  assert.deepEqual(r.findings.filter(f=>f.id==='unhandled-rejection').map(f=>f.line),[1,2,3,4]);
}));

test('Axios clients use lexical bindings, and mutated defaults cannot hide calls', async () => fixture(async root => {
  await writeFile(path.join(root,'server.ts'), [
    "import axios from 'axios';",
    "const api = axios.create({timeout:5000});",
    "api.defaults.timeout = 0;",
    "api.get('url');",
    "api.get('url',{timeout:3000});",
    "function handler(api) { return api.get('url'); }",
    "{ const api = axios.create({timeout:0}); api.get('url'); }",
    "function inner() { const api=axios.create({timeout:2000}); return api.get('url'); }",
    "let other=axios.create({timeout:3000});",
    "other=unknownClient;",
    "other.get('url');",
  ].join('\n'));
  const r=await runAudit(root);
  const findings=r.findings.filter(f=>f.id==='outbound-no-timeout');
  assert.deepEqual(findings.map(f=>f.line).sort((a,b)=>a-b),[4,7,11]);
  assert.equal(findings.find(f=>f.line===4).confidence,'low');
  assert.equal(findings.find(f=>f.line===11).confidence,'low');
}));

test('single-file discovery finds nearest project, scopes fixes, and stops at Git boundaries', async () => fixture(async root => {
  await writeFile(path.join(root,'package.json'),JSON.stringify({dependencies:{express:'1','@prisma/client':'1'}}));
  await mkdir(path.join(root,'src'));
  const file=path.join(root,'src','route.mts');
  await writeFile(file,"fetch('https://example.com');\n");
  await writeFile(path.join(root,'src','sibling.ts'),"fetch('https://example.org');\n");
  const r=await runAudit(file,{codemod:'apply'});
  assert.equal(r.fingerprint.framework,'Express');
  assert.equal(r.fingerprint.orm,'Prisma');
  assert.equal(r.coverage.analyzed,1);
  assert.deepEqual(r.codemod.files,['src/route.mts']);
  assert.doesNotMatch(await readFile(path.join(root,'src','sibling.ts'),'utf8'),/AbortSignal/);
  await writeFile(path.join(root,'src','package.json'),JSON.stringify({dependencies:{fastify:'1'}}));
  assert.equal((await runAudit(file)).fingerprint.framework,'Fastify');
  await rm(path.join(root,'src','package.json'));
  await mkdir(path.join(root,'src','.git'));
  assert.equal((await runAudit(file)).fingerprint.framework,null);
}));

async function preview(responses, {advance=1500}={}) {
  let submit, calls=0, active=0, maxActive=0, now=0;
  const out={style:{},textContent:''},button={disabled:false},location={href:''};
  const form={querySelector:()=>button,addEventListener:(_,fn)=>{submit=fn;}};
  const document={getElementById:id=>id==='f'?form:id==='out'?out:{value:'https://github.com/o/r'}};
  const context={document,location,Error,AbortSignal,Date:{now:()=>now},encodeURIComponent,
    setTimeout:fn=>{now+=advance;queueMicrotask(fn);},
    fetch:async (url,options)=>{
      assert.ok(options.signal);
      active++;maxActive=Math.max(maxActive,active);calls++;
      try {
        const value=responses.shift();
        if(value instanceof Error) throw value;
        assert.ok(value,'unexpected extra request');
        return {ok:value.ok??true,status:value.status??200,json:async()=>{if(value.badJson)throw new Error('Invalid JSON');return value.body;}};
      } finally {active--;}
    }};
  vm.runInNewContext(PREVIEW_SCRIPT,context);
  await submit({preventDefault(){}});
  assert.equal(button.disabled,false);
  return {out,location,calls,maxActive};
}
test('preview stops on network, HTTP, invalid JSON, missing status and failed-job responses', async () => {
  const scenarios=[
    [new Error('Network failed')],
    [{body:{id:'x'}},{ok:false,status:404,body:{error:'not found'}}],
    [{body:{id:'x'}},{badJson:true}],
    [{body:{id:'x'}},{body:{}}],
    [{body:{id:'x'}},{body:{status:'error',error:'audit failed'}}],
  ];
  for(const responses of scenarios) {
    const r=await preview(responses);
    assert.match(r.out.textContent,/^error:/);
    assert.equal(responses.length,0);
  }
});
test('preview polling is sequential, completes successfully, and has an overall deadline', async () => {
  const r=await preview([{body:{id:'x'}},{body:{status:'running'}},{body:{status:'done'}}]);
  assert.equal(r.location.href,'/report/x');
  assert.equal(r.maxActive,1);
  const expired=await preview([{body:{id:'x'}}],{advance:300000});
  assert.match(expired.out.textContent,/5 minutes/);
  assert.equal(expired.calls,1);
});
