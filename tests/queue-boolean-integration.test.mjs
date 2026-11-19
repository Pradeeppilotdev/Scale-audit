import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";

async function audit(setup, condition = "Boolean(full())") {
  const root = await mkdtemp(join(tmpdir(), "scale-boolean-integration-"));
  try {
    await writeFile(join(root, "server.ts"), `import { createServer } from 'node:http';
      ${setup}
      const jobs = []; let count = 0;
      function full() { return count >= 10; }
      function drain(job) { if (job !== undefined) count--; }
      setInterval(() => drain(jobs.shift()), 10);
      createServer(req => {
        if (${condition}) return;
        jobs.push(req.url); count++;
      });`);
    return await detectQueueBackpressure(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const [name, setup, condition] of [
  ["unrelated local assignment", "function local() { let Boolean; Boolean = () => false; } local();", "Boolean(full())"],
  ["native host method", "", "globalThis.Boolean(full())"],
  ["native computed method", 'const key = "Boolean";', "globalThis[key](full())"],
  ["native host alias", "const host = globalThis;", "host.Boolean(full())"],
  ["function captured before replacement", "const cast = Boolean; globalThis.Boolean = () => false;", "cast(full())"],
  ["alias chain captured before replacement", "const first = globalThis.Boolean; globalThis.Boolean = () => false; const cast = first;", "cast(full())"],
  ["destructured function captured before replacement", "const { Boolean: cast } = globalThis; globalThis.Boolean = () => false;", "cast(full())"],
]) {
  test(`${name} preserves native Boolean admission`, async () => {
    assert.deepEqual(await audit(setup, condition), []);
  });
}

for (const [name, setup, condition] of [
  ["host method", "globalThis.Boolean = () => false;", "globalThis.Boolean(full())"],
  ["computed method", 'globalThis.Boolean = () => false; const key = "Boolean";', "globalThis[key](full())"],
  ["host alias", "const host = globalThis; host.Boolean = () => false;", "host.Boolean(full())"],
  ["function captured after replacement", "globalThis.Boolean = () => false; const cast = Boolean;", "cast(full())"],
  ["destructured function captured after replacement", "globalThis.Boolean = () => false; const { Boolean: cast } = globalThis;", "cast(full())"],
]) {
  test(`a replaced ${name} cannot hide an unbounded queue`, async () => {
    assert.equal((await audit(setup, condition)).length, 1);
  });
}

for (const [name, setup] of [
  ["computed copy key", 'const key = "Boolean"; Object.assign(globalThis, { [key]: () => false });'],
  ["computed descriptor key", 'const key = "Boolean"; Object.defineProperties(globalThis, { [key]: { value: () => false } });'],
  ["copy object alias", "const patch = { Boolean: () => false }; Object.assign(globalThis, patch);"],
  ["descriptor object alias", "const patch = { Boolean: { value: () => false } }; Object.defineProperties(globalThis, patch);"],
  ["copy alias chain", "const original = { Boolean: () => false }; const patch = original; Object.assign(globalThis, patch);"],
]) {
  test(`a Boolean-only ${name} preserves the interval evidence`, async () => {
    assert.equal((await audit(setup)).length, 1);
  });
}

for (const setup of [
  "const patch = { Boolean: () => false }; patch.setInterval = () => 0; Object.assign(globalThis, patch);",
  "const patch = { Boolean: () => false }; const alias = patch; alias.setInterval = () => 0; Object.assign(globalThis, patch);",
  "const patch = { Boolean: () => false }; modify(patch); Object.assign(globalThis, patch);",
  "const patch = { Boolean: { value: () => false } }; patch.setInterval = { value: () => 0 }; Object.defineProperties(globalThis, patch);",
  "const patch = { get Boolean() { this.setInterval = () => 0; return () => false; } }; Object.assign(globalThis, patch); Object.assign(globalThis, patch);",
]) {
  test(`an expanded or escaped patch cannot establish a native timer: ${setup}`, async () => {
    assert.deepEqual(await audit(setup), []);
  });
}

test("many copies of one wide Boolean patch reuse its shape within the normal work budget", async () => {
  const properties = Array.from({ length: 350 }, (_, i) => `extra${i}: ${i}`).join(",");
  const copies = Array(700).fill("patch").join(",");
  const setup = `const patch = { Boolean: () => false, ${properties} }; Object.assign(globalThis, ${copies});`;
  assert.equal((await audit(setup)).length, 1);
});
