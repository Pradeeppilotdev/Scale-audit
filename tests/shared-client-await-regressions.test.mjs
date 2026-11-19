import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectPerRequestClients } from "../dist/detectors/perRequestClient.js";

async function audit(body) {
  const root = await mkdtemp(join(tmpdir(), "scale-shared-client-await-"));
  try {
    await writeFile(join(root, "route.ts"), `import { PrismaClient } from '@prisma/client';
      let client;
      export async function GET() { ${body} return client; }`);
    return await detectPerRequestClients(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const guard of [
  allocation => `client ??= ${allocation};`,
  allocation => `client ||= ${allocation};`,
  allocation => `if (!client) client = ${allocation};`,
]) {
  for (const [argument, expected] of [
    ["await config()", 1],
    ["{ options: await config() }", 1],
    ["true ? await config() : {}", 1],
    ["false ? await config() : {}", 0],
    ["false && await config()", 0],
    ["true || await config()", 0],
    ["async () => await config()", 0],
    ["{}", 0],
  ]) {
    const body = guard(`new PrismaClient(${argument})`);
    test(`shared initialization accounts for argument completion: ${body}`, async () => {
      const findings = await audit(body);
      assert.equal(findings.length, expected);
      if (expected) assert.equal(findings[0].severity, "high");
    });
  }
}

for (const [body, expected] of [
  ["if(!client){await config();client=new PrismaClient();}", 1],
  ["await config();client ??= new PrismaClient();", 0],
  ["if(!client){client=new PrismaClient();await config();}", 0],
  ["if(!client){if(false){await config();}client=new PrismaClient();}", 0],
  ["if(!client){if(flag){await config();}client=new PrismaClient();}", 1],
  ["if(!client){const deferred=async()=>await config();client=new PrismaClient();}", 0],
]) {
  test(`shared initialization preserves suspension ordering: ${body}`, async () => {
    assert.equal((await audit(body)).length, expected);
  });
}
