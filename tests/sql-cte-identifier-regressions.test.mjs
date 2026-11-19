import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { runAudit } from "../dist/runner.js";

const postgres = { setup: "import { Pool } from 'pg'; const pool = new Pool();", call: "pool.query" };
const sqlite = { setup: "import { createClient } from '@libsql/client'; const client = createClient({url:'file:test.db'});", call: "client.execute" };
const wrapper = { setup: "import client from './wrapper';", call: "client.query" };
const capped = "(SELECT id FROM events LIMIT 2)";
const uncapped = "(SELECT id FROM events)";
const arrayReads = ["ARRAY[1 -- ] LIMIT 2\n]", "ARRAY[$q$] LIMIT 2$q$]"].map(array =>
  [`WITH x AS ${capped} SELECT id FROM events WHERE ${array} IS NOT NULL`, "high"]);
const outcomes = {
  quiet: [],
  review: [["unbounded-read", "medium", "low"]],
  runtime: [["unbounded-read", "medium", "low"]],
  high: [["unbounded-raw-query", "high", "high"]],
};

async function checkQueries(t, driver, cases) {
  const root = await mkdtemp(join(tmpdir(), "scale-cte-identifier-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = cases.map(([sql], index) => {
    const expression = typeof driver.call === "function" ? driver.call(sql) : `${driver.call}(${JSON.stringify(sql)})`;
    return `export function q${index}() { return ${expression}; }`;
  });
  await writeFile(join(root, "route.ts"), [driver.setup, ...source].join("\n"));
  const report = await runAudit(root);
  assert.equal(report.complete, true, JSON.stringify(report.detectors.filter(d => d.status !== "complete")));
  const reads = report.findings.filter(f => f.file === "route.ts" && ["unbounded-read", "unbounded-raw-query"].includes(f.id));
  for (const [i, [sql, expected]] of cases.entries()) {
    const findings = reads.filter(f => f.line === i + 2);
    const label = sql.length > 240 ? `${sql.slice(0, 200)}… (${sql.length} characters)` : sql;
    assert.deepEqual(findings.map(f => [f.id, f.severity, f.confidence]), outcomes[expected], label);
    if (expected === "review") assert.match(findings[0].message, /identifier|dialect/i, label);
    if (expected === "runtime") assert.match(findings[0].message, /runtime|dynamic/i, label);
  }
}

test("mixed quotes on a libSQL client follow the row source SQLite actually reads", async t => {
  const cases = [
    [`WITH "page" AS ${capped} SELECT * FROM page`, "quiet", 2],
    [`WITH PaGe AS ${capped} SELECT * FROM "page"`, "quiet", 2],
    [`WITH "Page" AS ${capped} SELECT * FROM PAGE`, "quiet", 2],
    [`WITH page AS ${capped} SELECT * FROM "Page"`, "quiet", 2],
    ['WITH `Page` AS ' + capped + ' SELECT * FROM page', "quiet", 2],
    [`WITH [Page] AS ${capped} SELECT id FROM page`, "quiet", 2],
    [`WITH page AS ${capped} SELECT [p].[id] FROM [Page] AS p`, "quiet", 2],
    [`WITH [Page] AS ${capped} SELECT * FROM events`, "high", 12],
    [`WITH 'Page' AS ${capped} SELECT * FROM page`, "quiet", 2],
    [`WITH page AS ${capped} SELECT * FROM 'Page'`, "quiet", 2],
    [`WITH 'p''age' AS ${capped} SELECT * FROM page`, "high", 12],
    ["WITH value AS (SELECT COUNT(*) AS n FROM events WHERE note = 'value') SELECT * FROM 'VALUE'", "quiet", 1],
    [`WITH "p$age" AS ${capped}, Visible AS (SELECT id FROM P$AGE WHERE id > 1) SELECT * FROM "VISIBLE"`, "quiet", 1],
    [`WITH "slice$union" AS ${capped} SELECT * FROM slice$union`, "quiet", 2],
    [`WITH "naïve" AS ${capped} SELECT * FROM Naïve`, "quiet", 2],
    [`WITH "naïve" AS ${capped} SELECT * FROM NAÏVE`, "high", 12],
    [`WITH "quoted_value" AS ${capped} SELECT * FROM quoted_value`, "quiet", 2],
    [`WITH "quoted_value" AS ${capped} SELECT * FROM 'events'`, "high", 12],
    [`WITH "page" AS ${capped} SELECT * FROM main.page`, "high", 12],
    [`WITH "pa""ge" AS ${capped} SELECT * FROM page`, "high", 12],
    [`WITH "page" AS ${capped} SELECT * FROM "limit 2"`, "high", 12],
    [`WITH "Page" AS ${uncapped} SELECT * FROM page`, "high", 12],
    [`WITH "Page" AS ${capped} SELECT p.id FROM page p CROSS JOIN events`, "high", 24],
    [`WITH "Page" AS ${capped} SELECT * FROM page UNION ALL SELECT id FROM events`, "high", 14],
    ['WITH "Walk"(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM walk WHERE n < 12) SELECT n FROM WALK', "high", 12],
    ["WITH 'Walk'(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM 'walk' WHERE n < 12) SELECT n FROM WALK", "high", 12],
  ];
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE events(id INTEGER, note TEXT DEFAULT 'value'); CREATE TABLE page(id INTEGER); CREATE TABLE \"limit 2\"(id INTEGER)");
    const insert = db.prepare("INSERT INTO events(id) VALUES (?)");
    for (let id = 1; id <= 12; id++) insert.run(id);
    db.exec('INSERT INTO page SELECT id FROM events; INSERT INTO "limit 2" SELECT id FROM events; CREATE TABLE "naÏve" AS SELECT id FROM events');
    for (const [sql, , rows] of cases) assert.equal(db.prepare(sql).all().length, rows, sql);
  } finally {
    db.close();
  }
  await checkQueries(t, sqlite, cases);
});

test("a PostgreSQL pool folds bare CTE names and preserves distinct delimited names", async t => {
  const ctes = `WITH "Page" AS ${capped}, page AS ${uncapped} `;
  await checkQueries(t, postgres, [
    [`WITH "page" AS ${capped} SELECT * FROM PAGE`, "quiet"],
    [`WITH PaGe AS ${capped} SELECT * FROM "page"`, "quiet"],
    [`WITH "base" AS ${capped}, Page AS (SELECT id FROM BASE) SELECT * FROM "page"`, "quiet"],
    [`WITH "slice$union" AS ${capped} SELECT * FROM slice$union`, "quiet"],
    [`WITH slice$from AS ${capped} SELECT * FROM "slice$from"`, "quiet"],
    [`WITH "naïve" AS ${capped} SELECT * FROM Naïve`, "quiet"],
    [`WITH "naïve" AS ${capped} SELECT * FROM NAÏVE`, "high"],
    [`WITH "quoted_value" AS ${capped} SELECT * FROM quoted_value`, "quiet"],
    [`WITH "Page" AS ${capped} SELECT * FROM page`, "high"],
    [`WITH Page AS ${capped} SELECT * FROM "Page"`, "high"],
    [ctes + 'SELECT * FROM "Page"', "quiet"],
    [ctes + 'SELECT * FROM "page"', "high"],
    [ctes + 'SELECT * FROM PAGE', "high"],
    [`WITH "page" AS ${capped} SELECT * FROM public.page`, "high"],
    [`WITH "page" AS ${capped} SELECT samples[1] FROM events`, "high"],
    ...arrayReads,
    [`WITH "pa""ge" AS ${capped} SELECT * FROM page`, "high"],
  ]);
});

test("an unidentified SQL client requests review only where a different folding rule could change the bound", async t => {
  await checkQueries(t, wrapper, [
    [`WITH "page" AS ${capped} SELECT * FROM page`, "review"],
    [`WITH page AS ${capped} SELECT * FROM "Page"`, "review"],
    [`WITH [Page] AS ${capped} SELECT * FROM page`, "review"],
    [`WITH [Page] AS ${capped} SELECT * FROM events`, "high"],
    [`WITH page AS ${capped} SELECT * FROM 'Page'`, "review"],
    [`WITH page AS ${uncapped} SELECT * FROM 'Page'`, "high"],
    [`WITH "Page" AS ${capped} SELECT * FROM "Page"`, "quiet"],
    ['WITH `page` AS ' + capped + ' SELECT * FROM page', "quiet"],
    [`WITH "Page" AS ${capped} SELECT * FROM page LIMIT 1`, "quiet"],
    [`WITH "Page" AS ${uncapped} SELECT * FROM page`, "high"],
    [`WITH "Page" AS ${capped} SELECT * FROM other_page`, "high"],
    [`WITH "Page" AS ${capped} SELECT * FROM main.page`, "high"],
    [`WITH "page" AS ${capped} SELECT samples[1] FROM events`, "high"],
    ...arrayReads,
    [`WITH "Page" AS ${capped} SELECT * FROM page CROSS JOIN events`, "high"],
    [`WITH "Page" AS ${capped} SELECT * FROM page UNION ALL SELECT id FROM events`, "high"],
    [`WITH "Page" AS ${capped} SELECT id FROM events UNION ALL SELECT * FROM page`, "high"],
    [`WITH "Page" AS ${capped} SELECT * FROM page INTERSECT SELECT COUNT(*) FROM events`, "quiet"],
    [`WITH "Page" AS ${capped} SELECT * FROM page; SELECT * FROM events`, "high"],
    [`SELECT * FROM events; WITH "Page" AS ${capped} SELECT * FROM page`, "high"],
  ]);
});

for (const [label, driver] of [
  ["an unrelated libSQL client", { setup: "import { createClient } from '@libsql/client'; const other = createClient({url:'file:other.db'}); const client = external;", call: "client.execute" }],
  ["a replaced libSQL client", { setup: "import { createClient } from '@libsql/client'; let client = createClient({url:'file:other.db'}); client = external;", call: "client.execute" }],
  ["a replaced pg client", { setup: "import { Pool } from 'pg'; let client = new Pool(); client = external;", call: "client.query" }],
]) test(label + " does not establish the SQL name folding used by another call", async t => {
  await checkQueries(t, driver, [[`WITH "Page" AS ${capped} SELECT * FROM page`, "review"]]);
});

for (const [label, driver, writes, expected] of [
  ["replacement of client.execute", sqlite, "client.execute = query => remote.query(query);", "review"],
  ["replacement of client.execute through an alias", sqlite, "const alias = client; alias.execute = query => remote.query(query);", "review"],
  ["replacement of a named pg pool's query method", postgres, "pool.query = query => remote.query(query);", "review"],
  ["an unrelated property on the same client", sqlite, "client.trace = log;", "quiet"],
  ["the same method on a different client", sqlite, "const other = createClient({url:'file:other.db'}); other.execute = fn;", "quiet"],
]) test(label + " preserves the appropriate level of SQL dialect evidence", async t => {
  await checkQueries(t, { ...driver, setup: driver.setup + " " + writes }, [
    [`WITH "Page" AS ${capped} SELECT * FROM page`, expected],
    [`WITH "Page" AS ${uncapped} SELECT * FROM page`, "high"],
  ]);
});

for (const [label, setup, differs, lower] of [
  ["Knex's default import with a final sqlite3 client", "import knex from 'knex'; const db = knex({...options, client:'sqlite3'});", "quiet", "quiet"],
  ["Knex's named import with a pg client", "import {knex as connect} from 'knex'; const db = connect({client:'pg'});", "high", "quiet"],
  ["a CommonJS Knex factory with a sqlite3 client", "const connect = require('knex'); const db = connect({client:'sqlite3'});", "quiet", "quiet"],
  ["a later Knex option spread", "import knex from 'knex'; const db = knex({client:'sqlite3', ...options});", "review", "review"],
  ["a Knex client accessor", "import knex from 'knex'; const db = knex({get client() {return 'sqlite3';}});", "review", "review"],
  ["an external Knex settings binding", "import knex from 'knex'; import settings from 'app-settings'; const db = knex(settings);", "review", "review"],
]) test(label + " selects the appropriate CTE comparison", async t => {
  await checkQueries(t, { setup, call: "db.raw" }, [
    [`WITH "Page" AS ${capped} SELECT * FROM page`, differs],
    [`WITH "page" AS ${capped} SELECT * FROM page`, lower],
    [`WITH "page" AS ${uncapped} SELECT * FROM page`, "high"],
  ]);
});

for (const [label, driver, bounded, unbounded] of [
  ["a libSQL statement object", { ...sqlite, call: sql => `client.execute({sql:${JSON.stringify(sql)},args:[]})` }, "quiet", "high"],
  ["a libSQL statement object on an alias", { setup: sqlite.setup + " const replica = client;", call: sql => `replica.execute({sql:${JSON.stringify(sql)},args:[]})` }, "quiet", "high"],
  ["a final explicit SQL string", { ...sqlite, call: sql => `client.execute({...options, sql:${JSON.stringify(sql)}})` }, "quiet", "high"],
  ["a later SQL option spread", { ...sqlite, call: sql => `client.execute({sql:${JSON.stringify(sql)}, ...options})` }, "runtime", "runtime"],
  ["a later computed SQL option", { ...sqlite, call: sql => `client.execute({sql:${JSON.stringify(sql)}, [key]: text})` }, "runtime", "runtime"],
  ["a PostgreSQL query config", { ...postgres, call: sql => `pool.query({text:${JSON.stringify(sql)},values:[]})` }, "quiet", "high"],
]) test(label + " follows the effective query text on its client", async t => {
  await checkQueries(t, driver, [
    [`WITH "page" AS ${capped} SELECT * FROM page`, bounded],
    [`WITH "page" AS ${uncapped} SELECT * FROM page`, unbounded],
  ]);
});

for (const [label, call] of [
  ["raw SQL call", "prisma.$queryRawUnsafe"],
  ["tagged SQL template", sql => 'prisma.$queryRaw`' + sql + '`'],
]) test("Prisma " + label + " reports dialect uncertainty independently of definite row bounds", async t => {
  await checkQueries(t, { setup: "import prisma from './connection';", call }, [
    [`WITH "Page" AS ${capped} SELECT * FROM page`, "review"],
    [`WITH "Page" AS ${capped} SELECT * FROM page LIMIT 1`, "quiet"],
    [`WITH "Page" AS ${capped} SELECT * FROM events`, "high"],
  ]);
});

for (const [dialect, driver, whenCapped] of [["PostgreSQL", postgres, "quiet"], ["an unidentified client", wrapper, "review"]]) {
  test("mixed-quote CTE proofs fit the existing SQL work limit for " + dialect, async t => {
    const entries = ['"c0" AS ' + capped];
    for (let i = 1; i < 400; i++) {
      const name = i % 2 ? `C${i}` : `"c${i}"`;
      const parent = i % 2 ? `C${i - 1}` : `"c${i - 1}"`;
      entries.push(`${name} AS (SELECT id FROM ${parent})`);
    }
    const branches = Array.from({ length: 64 }, () => 'SELECT * FROM "c399"');
    const sql = 'WITH ' + entries.join(',') + ' ' + branches.join(' UNION ALL ');
    await checkQueries(t, driver, [[sql, whenCapped], [sql.replace('LIMIT 2', ''), "high"]]);
  });
}
