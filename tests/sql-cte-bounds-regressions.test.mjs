import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { runAudit } from "../dist/runner.js";

async function audit(sql) {
  const root = await mkdtemp(join(tmpdir(), "scale-cte-bounds-"));
  try {
    const source = sql.map((query, i) => "export function q" + i + "() { return client.query(" + JSON.stringify(query) + "); }");
    await writeFile(join(root, "route.ts"), source.join("\n"));
    return await runAudit(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const page = "WITH page AS (SELECT id FROM events LIMIT 2) ";
const cases = [
  [page + "SELECT * FROM page", 2, false],
  [page + "SELECT * FROM events", 12, true],
  ["WITH Page(k) AS MATERIALIZED (SELECT id FROM events ORDER BY id LIMIT 3) SELECT DISTINCT p.k AS key FROM PAGE AS p WHERE p.k >= 2 ORDER BY p.k DESC", 2, false],
  ['WITH "a""b" AS(SELECT id FROM events LIMIT 2) SELECT p.* FROM "a""b" p', 2, false],
  ["WITH unused AS(SELECT id FROM events), cap(x) AS NOT MATERIALIZED (SELECT id FROM events LIMIT 2 OFFSET 1) SELECT x FROM cap", 2, false],
  ["WITH id AS (SELECT id FROM events LIMIT 2) SELECT * FROM id", 2, false],
  ['WITH totals AS(SELECT COUNT(*) AS "size" FROM events) SELECT * FROM totals', 1, false],
  ["WITH base AS (SELECT id FROM events LIMIT 3), slim AS (SELECT id FROM base WHERE id > 1) SELECT * FROM slim", 2, false],
  ["WITH base AS (SELECT id FROM events), slim AS (SELECT id FROM base WHERE id > 1) SELECT * FROM slim", 11, true],
  ['WITH "cap" AS(SELECT id FROM events LIMIT 1), "full" AS(SELECT id FROM events) SELECT * FROM "full"', 12, true],
  [page + "SELECT c.id FROM page c JOIN events e ON 1=1", 24, true],
  [page + "SELECT c.id FROM page c, events e", 24, true],
  [page + "SELECT e.value FROM page c JOIN json_each('[1,2,3]') AS e", 6, true],
  [page + "SELECT * FROM page UNION ALL SELECT id FROM events", 14, true],
  [page + "SELECT * FROM page UNION ALL SELECT * FROM page", 4, false],
  ["WITH p AS(SELECT id FROM events UNION ALL SELECT id FROM events LIMIT 2) SELECT * FROM p", 2, false],
  ["WITH p AS(SELECT id FROM events UNION ALL SELECT COUNT(*) FROM events) SELECT * FROM p", 13, true],
  ["WITH p AS(SELECT id FROM events LIMIT -1) SELECT * FROM p", 12, true],
  ["WITH p AS(SELECT id FROM events LIMIT 1*(SELECT COUNT(*) FROM events)) SELECT * FROM p", 12, true],
  ["WITH p AS(SELECT id FROM events WHERE 'LIMIT 2' <> '') SELECT * FROM p", 12, true],
  ["WITH p AS(SELECT id FROM events LIMIT ?) SELECT * FROM p", 12, true, [-1]],
  ...["WITH ", "WITH RECURSIVE "].map(prefix =>
    [prefix + "walk(n) AS(SELECT 1 UNION ALL SELECT n+1 FROM walk WHERE n<12) SELECT * FROM walk", 12, true]),
  ...["merge", "replace", "sales$update"].flatMap(name => [true, false].map(cap =>
    ["WITH " + name + " AS (SELECT id FROM events" + (cap ? " LIMIT 2" : "") + ") SELECT * FROM " + name, cap ? 2 : 12, !cap])),
  ...["page$$", "page$tag$"].flatMap(name => [
    [page + "SELECT * FROM " + name, 12, true],
    ["WITH " + name + " AS(SELECT id FROM events LIMIT 2) SELECT * FROM " + name, 2, false],
  ]),
];

test("direct CTE bounds match SQLite cardinality across projections, expanding reads and named sources", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE events(id INTEGER); CREATE TABLE page$$(id INTEGER); CREATE TABLE page$tag$(id INTEGER)");
    const insert = db.prepare("INSERT INTO events VALUES (?)");
    for (let id = 1; id <= 12; id++) insert.run(id);
    db.exec("INSERT INTO page$$ SELECT * FROM events; INSERT INTO page$tag$ SELECT * FROM events");
    const report = await audit(cases.map(([sql]) => sql));
    assert.equal(report.complete, true);
    const flagged = new Set(report.findings.filter(f => f.id === "unbounded-raw-query").map(f => f.line));
    for (const [i, [sql, expectedRows, warning, args = []]] of cases.entries()) {
      assert.equal(db.prepare(sql).all(...args).length, expectedRows, sql);
      assert.equal(flagged.has(i + 1), warning, sql);
    }
  } finally {
    db.close();
  }
});

test("source identity and row bounds stay local to the SQL statement and query branch", async () => {
  const queries = [
    [page + "SELECT * FROM page; SELECT * FROM page", true],
    [page + "SELECT generate_series(1, id) FROM page", true],
    [page + "SELECT unnest(array_of_ids) FROM page", true],
    ["WITH p AS(SELECT TOP (2) id FROM events) SELECT * FROM p", false],
    ["WITH p AS(SELECT TOP 2 WITH TIES id FROM events ORDER BY id) SELECT * FROM p", true],
    ["WITH p AS(SELECT id FROM events OFFSET 0 ROWS FETCH NEXT 2 ROWS ONLY) SELECT * FROM p", false],
    ["WITH p AS(SELECT id FROM events FETCH FIRST 2 ROWS WITH TIES) SELECT * FROM p", true],
    ["WITH p AS(SELECT id FROM events WHERE note = $str$LIMIT 2$str$) SELECT * FROM p", true],
    ["WITH p AS(SELECT id FROM events LIMIT 2) SELECT * FROM p $unclosed$", true],
    ["WITH x AS(SELECT id FROM events LIMIT 2) UPDATE events SET id=id", false],
    ["WITH x AS(SELECT id FROM events LIMIT 2) UPDATE events SET id=id RETURNING id", true],
  ];
  const report = await audit(queries.map(([sql]) => sql));
  assert.equal(report.complete, true);
  const flagged = new Set(report.findings.filter(f => f.id === "unbounded-raw-query").map(f => f.line));
  queries.forEach(([sql, warning], i) => assert.equal(flagged.has(i + 1), warning, sql));
});

test("many direct aliases reused by multiple set operands fit the existing SQL work limit", async () => {
  const entries = ["c0 AS(SELECT id FROM events LIMIT 2)"];
  for (let i = 1; i < 750; i++) entries.push("c" + i + " AS(SELECT id FROM c" + (i - 1) + ")");
  const branches = Array.from({ length: 80 }, () => "SELECT * FROM c749");
  const sql = "WITH " + entries.join(",") + " " + branches.join(" UNION ALL ");
  const report = await audit([sql, sql.replace("LIMIT 2", "")]);
  assert.equal(report.complete, true);
  assert.deepEqual(report.findings.filter(f => f.id === "unbounded-raw-query").map(f => f.line), [2]);
});

for (const [reason, levels, padding] of [["recursion limit", 70, 0], ["work budget", 32, 6000]]) {
  test("CTE inference retains strict SQL " + reason + " exhaustion", async () => {
    const operand = "(".repeat(levels) + "SELECT " + " ".repeat(padding) + "id FROM events" + ")".repeat(levels);
    const report = await audit(["WITH cap AS (SELECT id FROM events UNION ALL " + operand + ") SELECT * FROM cap"]);
    assert.equal(report.complete, false);
    const detector = report.detectors.find(d => d.name === "detectUnboundedReads");
    assert.equal(detector.status, "failed");
    assert.match(detector.reason, new RegExp("SQL bounds.*" + reason));
  });
}
