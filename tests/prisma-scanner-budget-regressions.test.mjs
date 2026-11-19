import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { parseModels } from "../dist/prisma.js";

test("schema strings cannot supply indexes, comments or model boundaries", () => {
  const models = parseModels(`model Event {
    id String @id
    payload String @default("} // /* @unique @@index([payload])")
    owner String
    @@index([owner(sort: Desc)])
  }`);
  assert.deepEqual([...models.keys()], ["event"]);
  assert.deepEqual([...models.get("event").indexed].sort(), ["id", "owner"]);
  assert.ok(models.get("event").scalarFields.has("payload"));
});

test("escaped quotes and multiline comments preserve later real schema fields", () => {
  const models = parseModels(String.raw`model Event {
    id String @id
    payload String @default("escaped \" @unique")
    /* @@index([payload])
       model Fake { id String @id }
    */
    owner String @unique // no index on payload
  }`);
  assert.deepEqual([...models.keys()], ["event"]);
  assert.deepEqual([...models.get("event").indexed].sort(), ["id", "owner"]);
});

test("unterminated schema comments do not expose fake indexes", () => {
  const models = parseModels("model Event {\n id String @id\n}\n/* model Fake { id String @id }");
  assert.deepEqual([...models.keys()], ["event"]);
});

test("a long unterminated escaped string cannot cause repeated suffix scans", () => {
  const module = new URL("../dist/prisma.js", import.meta.url).href;
  const script = `import { parseModels } from ${JSON.stringify(module)};
    const source = 'model Event {\\n id String @default("' + '\\\\"'.repeat(160000);
    process.stdout.write(String(parseModels(source).size));`;
  // Isolate the historical quadratic case so a regression cannot hang the
  // entire suite. The linear scan normally finishes far below this deadline.
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", timeout: 10000,
  });
  assert.equal(result, "0");
});
