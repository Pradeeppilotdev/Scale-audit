import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectFloatingPromises } from "../dist/detectors/floatingPromise.js";

async function check(source) {
  const root = await mkdtemp(join(tmpdir(), "scale-property-history-"));
  try {
    await writeFile(join(root, "server.ts"), source);
    return (await detectFloatingPromises(root)).filter(finding => finding.id === "floating-promise");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const count of [500, 1000]) {
  for (const execution of ["same list", "external entry", "locally referenced entry"]) {
    test(`${count} property writes and reads reuse history in a ${execution}`, async () => {
      const setup = `const api={handler:()=>{}};${"api.handler=async()=>{};".repeat(count)}`;
      const calls = "api.handler();".repeat(count);
      const source = setup + (execution === "same list" ? calls
        : `export function GET(){${calls}}${execution === "locally referenced entry" ? "GET();" : ""}`);
      assert.equal((await check(source)).length, execution === "locally referenced entry" ? 0 : count);
    });
  }
}

test("property history lookup retains interleaved call timing", async () => {
  const source = "const api={handler:async()=>{}};api.handler();api.handler=()=>{};api.handler();api.handler=async()=>{};api.handler();";
  assert.equal((await check(source)).length, 2);
});

test("cached property history keeps conditional writes unknown", async () => {
  const source = `const api={handler:async()=>{}};${"api.handler=async()=>{};".repeat(1000)}
    if(flag)api.handler=()=>{};export function GET(){${"api.handler();".repeat(1000)}}`;
  assert.deepEqual(await check(source), []);
});
