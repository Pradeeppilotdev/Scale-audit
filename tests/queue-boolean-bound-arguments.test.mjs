import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";

async function audit(startup, condition, before = "") {
  const root = await mkdtemp(join(tmpdir(), "scale-boolean-bound-arguments-"));
  try {
    await writeFile(join(root, "server.ts"), `import { createServer } from 'node:http';
      const jobs = []; let count = 0;
      function full() { return count >= 10; }
      function drain(job) { if (job !== undefined) count--; }
      setInterval(() => drain(jobs.shift()), 10);
      ${startup}
      createServer(req => {
        ${before}
        if (${condition}) return;
        jobs.push(req.url); count++;
      });`);
    return await detectQueueBackpressure(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const bindings = [
  ["empty spread", "Boolean.bind(null, ...[])", 0],
  ["hole in this argument only", "Boolean.bind(...[,])", 0],
  ["bound hole", "Boolean.bind(null, ...[,])", 1],
  ["holes in this and bound arguments", "Boolean.bind(...[,,])", 1],
  ["nested bound hole", "Boolean.bind(null, ...[...[,]])", 1],
  ["bound hole before true", "Boolean.bind(null, ...[, true])", 1],
  ["bound hole before captured counter", "Boolean.bind(null, ...[, full()])", 1],
  ["explicit undefined", "Boolean.bind(null, undefined)", 1],
  ["bound true before hole", "Boolean.bind(null, ...[true, ,])", 0],
  ["empty then sparse binding", "Boolean.bind(null, ...[]).bind(null, ...[,])", 1],
  ["sparse then empty binding", "Boolean.bind(null, ...[,]).bind(null, ...[])", 1],
  ["earlier sparse argument wins", "Boolean.bind(null, ...[,]).bind(null, true)", 1],
  ["earlier true argument wins", "Boolean.bind(null, true).bind(null, ...[,])", 0],
];

for (const [name, binding, expected] of bindings) {
  for (const invoke of ["cast(full())", "cast.call(null, full())", "cast.apply(null, [full()])"]) {
    test(`${name} retains argument presence through ${invoke}`, async () => {
      // These fixed expressions check the actual native binding contract;
      // audited source itself is never executed.
      const runtime = Function("full", `return (${binding});`)(() => false);
      assert.equal(runtime(true), expected === 0);
      assert.equal((await audit(`const cast = ${binding};`, invoke)).length, expected);
    });
  }
}

for (const condition of [
  "Boolean(...[, full()])", "Boolean.call(...[null, , full()])",
  "Boolean.apply(null, [, full()])", "Boolean.apply(...[null, [, full()]])",
]) {
  test(`unbound coercion also retains a present undefined argument: ${condition}`, async () => {
    assert.equal((await audit("", condition)).length, 1);
  });
}

for (const condition of ["Boolean.call(...[, full()])", "Boolean.apply(null, [...[], full()])"]) {
  test(`a missing receiver or empty spread does not hide a live argument: ${condition}`, async () => {
    assert.deepEqual(await audit("", condition), []);
  });
}

for (const beforeReplacement of [true, false]) {
  test(`a sparse argument stays captured ${beforeReplacement ? "before" : "after"} global Boolean replacement`, async () => {
    const binding = "const native = Boolean; const cast = native.bind(null, ...[,]);";
    const replacement = "globalThis.Boolean = () => true;";
    const startup = beforeReplacement ? binding + replacement : replacement + binding;
    assert.equal((await audit(startup, "cast(full())")).length, 1);
  });
}

test("a sparse bound alias does not overwrite its unbound source alias", async () => {
  const startup = "const native = Boolean; const cast = native.bind(null, ...[,]); const again = cast;";
  assert.equal((await audit(startup, "again(full())")).length, 1);
  assert.deepEqual(await audit(startup, "native(full())"), []);
});

test("an independent live guard still protects a sparse bound call", async () => {
  assert.deepEqual(await audit("const cast = Boolean.bind(null, ...[,]);", "cast(full())", "if (full()) return;"), []);
});
