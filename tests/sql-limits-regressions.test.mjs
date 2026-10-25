import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runAudit} from '../dist/runner.js';

async function audit(source,verify,files={}) {
  const root=await mkdtemp(path.join(tmpdir(),'scale-sql-limits-'));
  try {
    for(const [file,content] of Object.entries({'route.ts':source,...files})) await writeFile(path.join(root,file),content);
    const report=await runAudit(root);assert.equal(report.complete,true);return verify(report);
  } finally {await rm(root,{recursive:true,force:true});}
}
const byId=(r,id)=>r.findings.filter(f=>f.id===id);

for(const sql of [
  '(SELECT * FROM users LIMIT 10) UNION ALL (SELECT * FROM admins)',
  '(SELECT * FROM users) UNION ALL (SELECT * FROM admins LIMIT 10)',
  '(SELECT * FROM users)',
  'SELECT * FROM (SELECT * FROM users LIMIT 10) u',
  'SELECT TOP 10 PERCENT * FROM users',
  'SELECT TOP (10) PERCENT * FROM users',
  'SELECT TOP 10 WITH TIES * FROM users ORDER BY score',
  'SELECT TOP 10 * FROM users UNION ALL SELECT * FROM admins',
  'SELECT * FROM users UNION SELECT TOP 10 * FROM admins',
  'SELECT * FROM users INTERSECT SELECT * FROM admins',
  'SELECT * FROM users EXCEPT SELECT TOP 10 * FROM admins',
  'SELECT * FROM users FETCH FIRST 10 PERCENT ROWS ONLY',
]) test(`SQL does not claim a full row bound: ${sql}`,async()=>audit(`export async function GET(){return client.query(${JSON.stringify(sql)});}`,r=>assert.equal(byId(r,'unbounded-raw-query').length,1)));

for(const sql of [
  '(SELECT * FROM users LIMIT 10) UNION ALL (SELECT * FROM admins LIMIT 20)',
  '(SELECT * FROM users) UNION ALL (SELECT * FROM admins) LIMIT 10',
  '(SELECT TOP 10 * FROM users UNION SELECT TOP 20 * FROM admins)',
  'SELECT TOP 10 * FROM users',
  'SELECT TOP (10) * FROM users',
  'SELECT TOP 10 * FROM users INTERSECT SELECT * FROM admins',
  'SELECT TOP 10 * FROM users EXCEPT SELECT * FROM admins',
  'SELECT TOP 10 * FROM users UNION ALL SELECT TOP 20 * FROM admins',
  'SELECT * FROM users UNION ALL SELECT * FROM admins LIMIT 10',
  'SELECT * FROM users UNION ALL SELECT * FROM admins FETCH FIRST 10 ROWS ONLY',
  'SELECT COUNT(*) FROM users UNION ALL SELECT COUNT(*) FROM admins',
  'SELECT TOP 10 * FROM users; SELECT TOP 20 * FROM admins',
]) test(`SQL retains concrete row bound: ${sql}`,async()=>audit(`export async function GET(){return client.query(${JSON.stringify(sql)});}`,r=>assert.equal(byId(r,'unbounded-raw-query').length,0)));

