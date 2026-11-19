import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectPerRequestClients } from "../dist/detectors/perRequestClient.js";

async function audit(source) {
  const root = await mkdtemp(join(tmpdir(), "scale-client-guard-identity-review-"));
  try {
    await writeFile(join(root, "route.ts"), source);
    return await detectPerRequestClients(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

const importedClient = "import { PrismaClient } from '@prisma/client';";
const guardedSource = body => `${importedClient}let client;export async function GET(){${body}return client;}`;

for (const wrapper of [
  value => value,
  value => `(${value})`,
  value => `((${value}))`,
  value => `(${value} as any)`,
  value => `(${value} satisfies unknown)`,
  value => `(${value})!`,
  value => `(<any>${value})`,
  value => `((<any>(${value} as any))!)`,
]) {
  for (const guard of [
    value => `client ??= ${value};`,
    value => `client ||= ${value};`,
    value => `if(!client){client=${value};}`,
  ]) {
    for (const awaited of [false, true]) {
      const body = guard(wrapper(`new PrismaClient(${awaited ? "await config()" : "{}"})`));
      test(`erased wrappers preserve shared initialization and suspension: ${body}`, async () => {
        const findings = await audit(guardedSource(body));
        assert.equal(findings.length, awaited ? 1 : 0);
        if (awaited) assert.equal(findings[0].severity, "high");
      });
    }
  }
}

for (const [body, expected] of [
  ["if(!client){for await(const config of configs){client=new PrismaClient(config);break;}}", 1],
  ["if(!client){for await(const config of configs){}client=new PrismaClient();}", 1],
  ["if(!client){for(const config of configs){client=new PrismaClient(config);break;}}", 0],
  ["if(!client){const config=await configs();client=new PrismaClient(config);}", 1],
  ["if(!client){client=new PrismaClient();for await(const config of configs){}}", 0],
  ["for await(const config of configs){}client??=new PrismaClient();", 0],
  ["if(!client){if(false){for await(const config of configs){}}client=new PrismaClient();}", 0],
  ["if(!client){const later=async()=>{for await(const config of configs){}};client=new PrismaClient();}", 0],
  ["if(!client){for await(const config of [client=new PrismaClient()]){}}", 0],
  ["if(!client){for await(const {value=client=new PrismaClient()} of configs){}}", 1],
  ["for await(const {value=(client??=new PrismaClient())} of configs){}", 0],
]) {
  test(`shared initialization accounts for iteration suspension: ${body}`, async () => {
    const findings = await audit(guardedSource(body));
    assert.equal(findings.length, expected);
    if (expected) assert.equal(findings[0].severity, "high");
  });
}

test("concurrent calls cross a for-await guard before either client is allocated", async () => {
  let client, allocations = 0;
  class FakeClient { constructor() { allocations++; } }
  async function request() {
    if (!client) {
      for await (const config of [{}]) { client = new FakeClient(config); break; }
    }
    return client;
  }
  await Promise.all([request(), request()]);
  assert.equal(allocations, 2);
});

for (const [name, setup, allocation, expected] of [
  ["import replaced by a local class", "let Db=PrismaClient;Db=class{};", "new Db()", 0],
  ["local class replaced by the import", "let Db=class{};Db=PrismaClient;", "new Db()", 1],
  ["import captured before replacement", "let Db=PrismaClient;const Captured=Db;Db=class{};", "new Captured()", 1],
  ["local class captured before import assignment", "let Db=class{};const Captured=Db;Db=PrismaClient;", "new Captured()", 0],
  ["import captured after assignment", "let Db=class{};Db=PrismaClient;const Captured=Db;", "new Captured()", 1],
  ["local class captured after assignment", "let Db=PrismaClient;Db=class{};const Captured=Db;", "new Captured()", 0],
  ["conditional replacement remains unknown", "let Db=PrismaClient;if(flag)Db=class{};", "new Db()", 0],
  ["nested replacement remains unknown", "let Db=PrismaClient;function update(){Db=class{};}update();", "new Db()", 0],
  ["import alias used without replacement", "const Db=PrismaClient;", "new Db()", 1],
]) {
  test(`client constructor identity preserves ${name}`, async () => {
    const findings = await audit(`${importedClient}${setup}export function GET(){return ${allocation};}`);
    assert.equal(findings.length, expected);
    if (expected) assert.equal(findings[0].severity, "high");
  });
}

test("constructor aliases use the write preceding each request-local allocation", async () => {
  const findings = await audit(`${importedClient}export function GET(){let Db=PrismaClient;const first=new Db();Db=class{};const second=new Db();return[first,second];}`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "high");
});

test("a replaced constructor with a familiar name cannot fall back to name evidence", async () => {
  assert.deepEqual(await audit("import{PrismaClient as Imported}from'@prisma/client';let PrismaClient=Imported;PrismaClient=class{};export function GET(){return new PrismaClient();}"), []);
});

for (const [imports, member] of [
  ["import * as native from '@prisma/client';", "PrismaClient"],
  ["import pg from 'pg';const native=pg;", "Pool"],
  ["import * as native from 'pg';", "Pool"],
  ["const native=require('pg');", "Pool"],
]) {
  const local = `{${member}:class{}}`;
  for (const [name, setup, receiver, expected] of [
    ["original namespace", "", "native", 1],
    ["native receiver replaced by local object", `let Alias=native;Alias=${local};`, "Alias", 0],
    ["local receiver replaced by native namespace", `let Alias=${local};Alias=native;`, "Alias", 1],
    ["captured native receiver", `let Alias=native;const Captured=Alias;Alias=${local};`, "Captured", 1],
    ["captured local receiver", `let Alias=${local};const Captured=Alias;Alias=native;`, "Captured", 0],
    ["conditional receiver replacement", `let Alias=native;if(flag)Alias=${local};`, "Alias", 0],
    ["unknown receiver replacement", "let Alias=native;Alias=external;", "Alias", 0],
  ]) {
    test(`namespace constructor identity keeps ${name}: ${imports}`, async () => {
      const findings = await audit(`${imports}${setup}export function GET(){return new ${receiver}.${member}();}`);
      assert.equal(findings.length, expected);
      if (expected) assert.equal(findings[0].severity, "high");
    });
  }
}

test("request-local namespace replacements use each allocation's current receiver", async () => {
  const findings = await audit("import * as native from '@prisma/client';export function GET(){let Alias=native;const first=new Alias.PrismaClient();Alias={PrismaClient:class{}};const second=new Alias.PrismaClient();return[first,second];}");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "high");
});

test("a local parameter's familiar member name is not an unresolved native constructor", async () => {
  assert.deepEqual(await audit("export function GET(local){return new local.Pool();}"), []);
});

for (const source of [
  "export function GET(){return new PrismaClient();}",
  "const{PrismaClient}=require('@prisma/client');export function GET(){return new PrismaClient();}",
  "import * as db from '@prisma/client';export function GET(){return new db.PrismaClient();}",
  "import pg from 'pg';export function GET(){return new pg.Pool();}",
  "import Redis from 'ioredis';export function GET(){return new Redis();}",
]) {
  test(`known constructor and factory forms remain recognized: ${source}`, async () => {
    const findings = await audit(source);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "high");
  });
}
