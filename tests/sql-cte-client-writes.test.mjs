import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAudit } from "../dist/runner.js";

const literal = JSON.stringify('WITH "page" AS (SELECT id FROM events LIMIT 2) SELECT * FROM page');

async function findings(t, files) {
  const root = await mkdtemp(join(tmpdir(), "scale-cte-method-writes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries(files)) await writeFile(join(root, name), contents);
  const report = await runAudit(root);
  assert.equal(report.complete, true);
  return report.findings.filter(f => f.file === "route.ts" && f.id.startsWith("unbounded"))
    .map(f => [f.line, f.id, f.severity, f.confidence]);
}

const review = line => [line, "unbounded-read", "medium", "low"];
const clients = [
  'import {createClient} from "@libsql/client";',
  'export const first=createClient({url:"file:one"}), second=createClient({url:"file:two"});',
];
const routes = [
  'import "./patch"; import {first, second} from "./clients";',
  'export function GET(){return first.execute(' + literal + ');}',
  'export function POST(){return second.execute(' + literal + ');}',
].join("\n");

for (const [kind, store, replacement] of [
  ["local shorthand", "", "const ctx={first,second}; ctx.first.execute=delegate;"],
  ["exported object", "export const clients={primary:first, spare:second};", "all.primary.execute=delegate;"],
  ["exported array", "export const clients=[first,second];", 'Object.defineProperty(all[0],"execute",{value:delegate});'],
]) {
  test("a cross-file patch through an " + kind + " only affects the stored client", async t => {
    const imports = store ? 'import {clients as all} from "./clients";' : 'import {first,second} from "./clients";';
    assert.deepEqual(await findings(t, {
      "clients.ts": [...clients, store].join("\n"), "patch.ts": imports + replacement, "route.ts": routes,
    }), [review(2)]);
  });
}

test("an aliased PostgreSQL prototype patch affects its instances after the write", async t => {
  const source = [
    'import {Client, Pool} from "pg"; const direct=new Client(), pooled=new Pool();',
    'pooled.query(' + literal + ');',
    'const ctor = Pool, target=ctor.prototype; Reflect.set(target, "query", delegate);',
    'pooled.query(' + literal + ');',
    'direct.query(' + literal + ');',
  ].join("\n");
  assert.deepEqual(await findings(t, { "route.ts": source }), [review(4)]);
});

for (const target of ["Object.getPrototypeOf(first)", 'Reflect["getPrototypeOf"](first)', "first.constructor.prototype", "first.__proto__"]) {
  test(target + " is a possible shared client prototype", async t => {
    const patch = 'import {first} from "./clients";const prototype=' + target + ';prototype.execute=delegate;';
    assert.deepEqual(await findings(t, { "clients.ts": clients.join("\n"), "patch.ts": patch, "route.ts": routes }),
      [review(2), review(3)]);
  });
}
