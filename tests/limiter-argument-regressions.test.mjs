import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectUnboundedConcurrency } from "../dist/detectors/unboundedConcurrency.js";

async function audit(expression, extra = "", concurrency = "5") {
  const root = await mkdtemp(join(tmpdir(), "scale-limiter-arguments-"));
  try {
    await writeFile(join(root, "route.ts"), `import pLimit from 'p-limit';
      const limit=pLimit(${concurrency});
      async function work(user){return fetch(user.url);}
      ${extra}
      export function GET(users){return Promise.all(users.map(user=>${expression}));}`);
    return await detectUnboundedConcurrency(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const [expression, extra] of [
  ["limit(fetch(user.url))", ""],
  ["limit(work(user))", ""],
  ["limit(()=>work(user),fetch(user.url))", ""],
  ["limit(work,fetch(user.url))", ""],
  ["limit(()=>work(user),JSON.parse(user.text, value=>{fetch(user.url);return value;}))", ""],
  ["limit(factory(user))", "function factory(user){fetch(user.url);return ()=>work(user);}"],
  ["limit(factory(user))", "async function factory(user){return ()=>work(user);}"],
]) {
  test(`eager work is outside the limiter: ${expression} ${extra}`, async () => {
    assert.equal((await audit(expression, extra)).length, 1);
  });
}

for (const [expression, extra] of [
  ["limit(()=>fetch(user.url))", ""],
  ["limit(work,user)", ""],
  ["limit(work,JSON.parse(user.text))", ""],
  ["limit(factory(user))", "function factory(user){return ()=>work(user);}"],
  ["limit(factory(user))", "function factory(user){return async()=>work(user);}"],
  ["limit(()=>work(user),()=>fetch(user.url))", ""],
]) {
  test(`deferred tasks and synchronous preparation remain bounded: ${expression} ${extra}`, async () => {
    assert.deepEqual(await audit(expression, extra), []);
  });
}

test("an overflowing numeric concurrency value is not a finite limiter", async () => {
  assert.equal((await audit("limit(()=>fetch(user.url))", "", "1e309")).length, 1);
});
