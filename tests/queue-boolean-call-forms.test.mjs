import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";

async function audit(condition, { startup = "", before = "", async = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "scale-boolean-call-forms-"));
  try {
    await writeFile(join(root, "server.ts"), `import { createServer } from 'node:http';
      const jobs = []; let count = 0;
      function full() { return count >= 10; }
      function drain(job) { if (job !== undefined) count--; }
      setInterval(() => drain(jobs.shift()), 10);
      ${startup}
      createServer(${async ? "async " : ""}req => {
        ${before}
        if (${condition}) return;
        jobs.push(req.url); count++;
      });`);
    return await detectQueueBackpressure(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const forms = [
  "Boolean?.(full())", "globalThis.Boolean?.(full())", "globalThis?.Boolean(full())",
  "Boolean(full(), 0)", "Boolean(...[full(), 0])", "Boolean(...[...[full()]])",
  "Boolean.call(null, full(), 0)", "Boolean.call(...[null, full()])",
  "Boolean['call'](null, full())", "Boolean.call?.(null, full())",
  "Boolean.apply(null, [full(), 0])", "Boolean.apply(null, [...[full()]])",
  "Boolean.bind(null)(full())", "Boolean.bind(null).bind(null)(full())",
  "Boolean.bind(null).call(null, full())",
];

for (const condition of forms) {
  test(`${condition} preserves native coercion`, async () => {
    assert.deepEqual(await audit(condition), []);
  });
  test(`${condition} cannot hide replacement of Boolean`, async () => {
    assert.equal((await audit(condition, { startup: "globalThis.Boolean = () => false;" })).length, 1);
  });
}

for (const condition of ["cast(full())", "cast.call(null, full())", "cast.apply(null, [full()])"]) {
  for (const capture of ["Boolean", "Boolean.bind(null)", "globalThis.Boolean.bind(null).bind(null)"]) {
    test(`${condition} retains ${capture} captured before replacement`, async () => {
      assert.deepEqual(await audit(condition, { startup: `const cast = ${capture}; globalThis.Boolean = () => false;` }), []);
    });
    test(`${condition} rejects ${capture} captured after replacement`, async () => {
      assert.equal((await audit(condition, { startup: `globalThis.Boolean = () => false; const cast = ${capture};` })).length, 1);
    });
  }
}

for (const [startup, condition] of [
  ["Boolean.call = () => false;", "Boolean.call(null, full())"],
  ["Object.assign(Boolean, { apply: () => false });", "Boolean.apply(null, [full()])"],
  ["Object.defineProperty(Boolean, 'bind', { value: () => () => false });", "Boolean.bind(null)(full())"],
  ["Function.prototype.call = () => false;", "Boolean.call(null, full())"],
  ["const proto = Function.prototype; proto.apply = () => false;", "Boolean.apply(null, [full()])"],
  ["Object.assign(Function.prototype, { bind: () => () => false });", "Boolean.bind(null)(full())"],
  ["const cast = Boolean.bind(null); cast.call = () => false;", "cast.call(null, full())"],
]) {
  test(`helper replacement contributes no capacity proof: ${startup}`, async () => {
    assert.equal((await audit(condition, { startup })).length, 1);
  });
}

for (const startup of [
  "Object.assign(Boolean, { label: 'coercion' });",
  "Function.prototype.apply = () => false;",
  "const other = () => false; other.call = () => false;",
]) {
  test(`unrelated properties do not poison Boolean.call: ${startup}`, async () => {
    assert.deepEqual(await audit("Boolean.call(null, full())", { startup }), []);
  });
}

test("an already bound coercion survives a later native bind replacement", async () => {
  assert.deepEqual(await audit("cast(full())", { startup: "const cast = Boolean.bind(null); Function.prototype.bind = () => () => false;" }), []);
});

test("own helper writes retain the identity of separate bound functions", async () => {
  const startup = "const safe = Boolean.bind(null), changed = Boolean.bind(null); changed.call = () => false;";
  assert.deepEqual(await audit("safe.call(null, full())", { startup }), []);
  assert.equal((await audit("changed.call(null, full())", { startup })).length, 1);
});

test("a chained bound coercion survives a later prototype bind replacement", async () => {
  const startup = "const cast = Boolean.bind(null).bind(null); Function.prototype.bind = () => () => false;";
  assert.deepEqual(await audit("cast(full())", { startup }), []);
});

test("a bound counter value is a snapshot rather than a live capacity check", async () => {
  const startup = "const cast = Boolean.bind(null, full());";
  assert.equal((await audit("cast()", { startup })).length, 1);
  assert.deepEqual(await audit("cast()", { startup, before: "if (full()) return;" }), []);
});

test("resolving a bound alias cannot attach its captured arguments to the original function", async () => {
  const startup = "const cast = Boolean; const captured = cast.bind(null, full());";
  assert.deepEqual(await audit("cast(full())", { startup, before: "if (captured()) return;" }), []);
});

for (const [condition, startup] of [
  ["Boolean(...args)", "const args = [full()];"],
  ["Boolean.apply(null, args)", "const args = [full()];"],
  ["cast()", "const cast = Boolean.bind(null, false);"],
  ["Boolean()", ""],
]) {
  test(`an opaque or false Boolean argument cannot establish capacity: ${condition}`, async () => {
    assert.equal((await audit(condition, { startup })).length, 1);
  });
}

for (const [condition, startup] of [["cast()", "const cast = Boolean.bind(null, true);"], ["Boolean(true)", ""]]) {
  test(`an always-true native coercion prevents the enqueue: ${condition}`, async () => {
    assert.deepEqual(await audit(condition, { startup }), []);
  });
}

for (const condition of ["Boolean(full(), await load())", "Boolean.apply(null, [full(), await load()])",
  "Boolean.call(null, full(), await load())"]) {
  test(`evaluated argument waits invalidate earlier capacity evidence: ${condition}`, async () => {
    assert.equal((await audit(condition, { before: "if (full()) return;", async: true })).length, 1);
  });
}

test("a skipped optional extra argument wait preserves a fresh capacity check", async () => {
  assert.deepEqual(await audit("Boolean.call(null, full(), false && await load())", { async: true }), []);
});
