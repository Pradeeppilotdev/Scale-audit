import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAudit } from "../dist/runner.js";

async function audit(t, source, files = {}) {
  const root = await mkdtemp(join(tmpdir(), "scale-read-cardinality-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries({ "route.ts": source, ...files })) {
    await writeFile(join(root, file), content);
  }
  const report = await runAudit(root);
  assert.equal(report.complete, true);
  return report;
}

const boundedRead = "await prisma.user.findMany({take:10})";
for (const [statement, repeated] of [
  [`return (${boundedRead}).map(row => row.id)`, false],
  [`return ids.map(id => id, ${boundedRead})`, false],
  [`for (const row of ${boundedRead}) consume(row)`, false],
  [`for (const key in ${boundedRead}) consume(key)`, false],
  [`for (let rows = ${boundedRead}; rows.length; rows.pop()) consume(rows)`, false],
  [`for (const id of ids) consume(${boundedRead})`, true],
  [`while ((${boundedRead}).length) consume()`, true],
  [`for (let i = 0; i < 10; i += (${boundedRead}).length) consume(i)`, true],
  [`return ids.map(async () => ${boundedRead})`, true],
  [`for (const id of ids) for (const row of ${boundedRead}) consume(row)`, true],
  [`return ids.map(() => async () => ${boundedRead})`, false],
]) {
  test(`N+1 uses the execution count of the read in ${statement}`, async t => {
    const report = await audit(t, `export async function GET(ids){${statement}}`);
    assert.equal(report.findings.filter(f => f.id === "n-plus-one").length, Number(repeated));
  });
}

test("formatting cannot merge independent calls or change their score", async t => {
  const statements = [
    "await prisma.product.findMany();",
    "await prisma.product.findMany();",
    "for (const id of ids) await prisma.user.findMany({where:{id}});",
  ];
  const compact = await audit(t, `export async function GET(ids){${statements.join("")}}`);
  const expanded = await audit(t, `export async function GET(ids){\n${statements.join("\n")}\n}`);
  for (const report of [compact, expanded]) {
    assert.equal(report.findings.filter(f => f.id === "unbounded-read").length, 2);
    assert.equal(report.findings.filter(f => f.id === "n-plus-one").length, 1);
  }
  assert.equal(compact.score, expanded.score);
  assert.equal(new Set(compact.findings.filter(f => f.category === "DB").map(f => f.column)).size, 3);
});

for (const [decl, receiver, expected] of [
  ["import {Pool} from 'pg'; const workers = new Pool();", "workers", 1],
  ["import {Client as Driver} from 'pg'; const main = new Driver(); const alias = main;", "alias", 1],
  ["const driver = require('pg');", "new driver.Pool()", 1],
  ["import pg from 'pg'; let workers = new pg.Pool(); workers = local;", "workers", 0],
  ["class Pool {} const workers = new Pool();", "workers", 0],
  ["import {Pool} from 'some-other-package'; const workers = new Pool();", "workers", 0],
]) {
  test(`raw SQL follows the receiver allocation: ${decl}`, async t => {
    const report = await audit(t, decl + "\nexport function GET(){return " + receiver + "['query']('SELECT * FROM events');}");
    assert.equal(report.findings.filter(f => f.id === "unbounded-raw-query").length, expected);
  });
}

test("an exported PostgreSQL pool retains identity across a barrel for SQL and N+1", async t => {
  const report = await audit(t, "import {pool} from './barrel'; export async function GET(ids){for(const id of ids) await pool.query('SELECT * FROM events');}", {
    "barrel.ts": "export {main as pool} from './db';",
    "db.ts": "import {Pool as Driver} from 'pg'; export const main = new Driver();",
  });
  assert.deepEqual(report.findings.filter(f => f.category === "DB").map(f => f.id).sort(), ["n-plus-one", "unbounded-raw-query"]);
});

for (const [sql, bounded] of [
  ["SELECT COUNT(*) AS total, MAX(id) AS last FROM events", true],
  ["SELECT min(id) first_id, sum(amount) AS total, 1 AS version FROM events", true],
  ["SELECT count(*) FILTER (WHERE visible), max(id) FROM events", true],
  ["SELECT COUNT(*), MAX(id) FROM events UNION ALL SELECT MIN(id), SUM(id) FROM old", true],
  ["SELECT COUNT(*), MAX(id) FROM events GROUP BY user_id", false],
  ["SELECT COUNT(*) OVER (), MAX(id) OVER () FROM events", false],
  ["SELECT max(a,b), min(c,d) FROM events", false],
  ["SELECT COUNT(*), generate_series(1,100) FROM events", false],
  ["SELECT COUNT(*) FROM events UNION ALL SELECT id FROM old", false],
  ["SELECT 1 AS ok", true],
  ["SELECT 1 AS ok FROM events", false],
]) {
  test(`PostgreSQL query result cardinality for ${sql}`, async t => {
    const report = await audit(t, `import {Pool} from 'pg'; const pool = new Pool(); export function GET(){return pool.query(${JSON.stringify(sql)});}`);
    assert.equal(report.findings.filter(f => f.id === "unbounded-raw-query").length, Number(!bounded));
  });
}

test("null equality on a nullable unindexed Prisma scalar is distinct from an omitted filter", async t => {
  const filters = ["processedAt:null", "processedAt:{equals:null}", "processedAt:undefined",
    "optionalIndexed:null", "required:null", "relation:null"];
  const report = await audit(t, filters.map(where => `prisma.event.findMany({take:10,where:{${where}}});`).join("\n"), {
    "schema.prisma": "model Event {\n id Int @id\n processedAt DateTime?\n optionalIndexed Int? @unique\n required String\n relation User?\n}",
  });
  assert.deepEqual(report.findings.filter(f => f.id === "missing-index").map(f => f.line), [1, 2]);
});

const lookup = "prisma.user.findUnique({where:{id}})";
for (const [name, body, expected] of [
  ["named map callback", `function load(id){return ${lookup}} return Promise.all(ids.map(load));`, 1],
  ["stable callback alias", `const load=id=>${lookup}; const alias=load; return ids.map(alias);`, 1],
  ["same helper via two collection calls", `const load=id=>${lookup}; ids.map(load); return ids.map(load);`, 1],
  ["helper called by inline projector", `const load=id=>${lookup}; return ids.map(id=>load(id));`, 1],
  ["non-repeating function passed as map thisArg", `const load=id=>${lookup}; return ids.map(id=>id,load);`, 0],
  ["reassigned callback", `let load=id=>${lookup}; load=id=>id; return ids.map(load);`, 0],
  ["custom map never invokes its callback", `const only={map(cb){return 1}}; function load(id){return ${lookup}} return only.map(load);`, 0],
  ["generator body deferred", `return Promise.all(ids.map(function*(id){return ${lookup}}));`, 0],
  ["async generator body deferred", `async function* load(id){return ${lookup}} return Promise.all(ids.map(load));`, 0],
  ["uniterated generator with an internal loop", `return ids.map(function*(){for(const id of ids) yield ${lookup}});`, 0],
  ["iterating a generator runs its internal loop", `function* load(){for(const id of ids) yield ${lookup}} return Promise.all(load());`, 1],
  ["reusing one iterator never restarts its body", `function* load(id){return ${lookup}} const it=load(0); for(const id of ids) it.next();`, 0],
  ["each iteration advances a new generator", `function* load(id){return ${lookup}} for(const id of ids){const it=load(id);it.next();}`, 1],
  ["promises collected with push", `const reads=[]; for(const id of ids) reads.push(${lookup}); return Promise.all(reads);`, 1],
  ["stable array alias consumed", `const reads=[]; const alias=reads; for(const id of ids) reads.push(${lookup}); return Promise.allSettled(alias);`, 1],
  ["different collection consumed", `const reads=[]; for(const id of ids) reads.push(${lookup}); return Promise.all([]);`, 0],
  ["collection consumed before the loop", `const reads=[]; Promise.all(reads); for(const id of ids) reads.push(${lookup});`, 0],
  ["shadowed Promise combinator", `const Promise={all(x){return 0}}; const reads=[]; for(const id of ids) reads.push(${lookup}); return Promise.all(reads);`, 0],
]) test(`N+1 callback execution and collected reads: ${name}`, async t => {
  const report = await audit(t, `export function GET(ids,prisma){${body}}`);
  assert.equal(report.findings.filter(f => f.id === 'n-plus-one').length, expected);
});

test("an imported named callback is attributed to its read site", async t => {
  const report = await audit(t, "import {load} from './db'; export function GET(ids){return Promise.all(ids.map(load));}", {
    "db.ts": `export function load(id){return ${lookup}}`,
  });
  assert.deepEqual(report.findings.filter(f => f.id === "n-plus-one").map(f => f.file), ["db.ts"]);
});

for (const [sql, returned] of [
  ["INSERT INTO archive SELECT id FROM events", false],
  ["WITH rows AS (SELECT id FROM events) INSERT INTO archive SELECT id FROM rows", false],
  ["CREATE TABLE copied AS SELECT id FROM events", false],
  ["CREATE TEMP VIEW cached AS SELECT id FROM events", false],
  ["INSERT INTO archive SELECT id FROM events RETURNING id", true],
  ["INSERT INTO archive SELECT id FROM events LIMIT 4 RETURNING id", false],
  ["WITH rows AS (SELECT id FROM events) SELECT id FROM rows", true],
  ["INSERT INTO archive SELECT id FROM events; SELECT id FROM archive", true],
  ["INSERT INTO archive SELECT 'RETURNING' FROM events", false],
  ["SELECT output FROM events LIMIT 1", false],
  ["SELECT output FROM events", true],
]) test(`SQL classifies the outer statement before its input rows: ${sql}`, async t => {
  const report = await audit(t, `export function GET(){return prisma.$queryRawUnsafe(${JSON.stringify(sql)});}`);
  assert.equal(report.findings.filter(f => f.id === "unbounded-raw-query").length, Number(returned));
});
