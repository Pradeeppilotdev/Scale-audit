import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";
import { detectSyncIo } from "../dist/detectors/syncIo.js";
import { AnalysisBudget } from "../dist/analysisBudget.js";

async function audit(source, detector = detectQueueBackpressure) {
  const root = await mkdtemp(join(tmpdir(), "scale-callback-stops-"));
  try {
    await writeFile(join(root, "server.ts"), source);
    return await detector(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function queues(body, setup = "") {
  return `import { createServer } from 'node:http';
    const jobs = [], other = []; let count = 0, otherCount = 0;
    function drain(job) { if (job !== undefined) count--; }
    function drainOther(job) { if (job !== undefined) otherCount--; }
    setInterval(() => drain(jobs.shift()), 100);
    setInterval(() => drainOther(other.shift()), 100);
    ${setup}
    createServer(req => { if (count === 11) return; ${body} });
    createServer(req => { other.push(req.url); otherCount++; });`;
}

function nativeCount(expression, body) {
  let calls = 0;
  new Function("observe", `${expression}(item => { observe(); ${body} });`)(() => calls++);
  return calls;
}

for (const method of ["some", "every", "find", "findIndex"]) {
  for (const body of ["return true;", "return false;", "return 1;", "return 0;", "", "return (true === true);"]) {
    test(`${method} uses a fixed callback completion: ${body || "implicit undefined"}`, async () => {
      const calls = nativeCount(`[1,2].${method}`, body);
      const source = queues(`[1,2].${method}(item => { jobs.push(item); count++; ${body} });`);
      const findings = await audit(source);
      assert.equal(findings.length, calls > 1 ? 2 : 1);
      assert.equal(findings.some(finding => /jobs\.push/.test(source.split("\n")[finding.line - 1])), calls > 1);
    });
  }
}

for (const [body, repeated] of [
  ["try { return false; } finally { return true; }", false],
  ["try { return true; } finally { return false; }", true],
  ["if (req.url) return true;", true],
  ["if (req.url) return true; else return true;", false],
  ["try { return true; } finally { if (req.url) return false; }", true],
  ["if (true) return true; return false;", false],
  ["if (req.url) throw new Error(); return true;", false],
]) {
  test(`some completion preserves control-flow alternatives: ${body}`, async () => {
    const findings = await audit(queues(`[1,2].some(item => { jobs.push(item); count++; ${body} });`));
    assert.equal(findings.length, repeated ? 2 : 1);
  });
}

for (const method of ["some", "every", "find", "findIndex"]) {
  test(`${method} uses the truthiness of an async result without awaiting it`, async () => {
    const findings = await audit(queues(`[1,2].${method}(async item => { jobs.push(item); count++; return false; });`));
    assert.equal(findings.length, method === "every" ? 2 : 1);
  });
}

test("a stopping async callback cannot borrow a capacity observation across await", async () => {
  const findings = await audit(queues("[1,2].some(async item => { await load(); jobs.push(item); count++; return false; });"));
  assert.equal(findings.length, 2);
});

for (const method of ["some", "every", "find", "findIndex"]) {
  test(`${method} invokes a throw-only synchronous callback at most once`, async () => {
    let calls = 0;
    assert.throws(() => [1, 2][method](() => { calls++; throw new Error("fixture"); }), /fixture/);
    assert.equal(calls, 1);
    assert.equal((await audit(queues(`[1,2].${method}(item => { jobs.push(item); count++; throw new Error('fixture'); });`))).length, 1);
  });
}

test("a conditional callback throw does not eliminate a continuing result", async () => {
  const source = queues("[1,2].some(item => { jobs.push(item); count++; if (req.url) throw new Error(); return false; });");
  assert.equal((await audit(source)).length, 2);
});

const http = "import { createServer } from 'node:http'; import { readFileSync } from 'node:fs';";
async function high(source) { return (await audit(http + source, detectSyncIo)).filter(finding => finding.severity === "high"); }

for (const expression of ["[undefined,1]", "[void 0,1]", "[undefined,,1]", "[undefined]", "[undefined,undefined]"]) {
  test(`${expression}.sort never calls its comparator`, async () => {
    assert.equal(nativeCount(`${expression}.sort`, "return 0;"), 0);
    assert.deepEqual(await high(`createServer(() => ${expression}.sort(() => { readFileSync('unused'); return 0; }));`), []);
  });
}

for (const expression of ["[undefined,1,2]", "[1,undefined,2]", "[null,1]", "[false,1]"]) {
  test(`${expression}.sort retains genuinely comparable values`, async () => {
    assert.ok(nativeCount(`${expression}.sort`, "return 0;") > 0);
    assert.equal((await high(`createServer(() => ${expression}.sort(() => { readFileSync('live'); return 0; }));`)).length, 1);
  });
}

test("a shadowed undefined value remains a possible comparator input", async () => {
  assert.equal((await high("const undefined = 2; createServer(() => [undefined,1].sort(() => readFileSync('live')));")).length, 1);
});

test("an aliased undefined value is excluded from comparator inputs", async () => {
  assert.deepEqual(await high("const absent = undefined; createServer(() => [absent,1].sort(() => readFileSync('unused')));"), []);
});

test("unknown rest payloads are not mistaken for undefined sort entries", async () => {
  assert.equal((await high("function sort(...items) { items.sort(() => readFileSync('live')); } createServer(req => sort(req.url, 1));")).length, 1);
});

for (const [method, result] of [["some", "true"], ["every", "false"], ["find", "true"], ["findIndex", "true"]]) {
  for (const values of ["[0,1]", "[,0,1]"]) {
    test(`${values}.${method} keeps only the first visited payload`, async () => {
      const findings = await high(`createServer(() => ${values}.${method}(item => { if (item) readFileSync('unused'); return ${result}; }));`);
      assert.deepEqual(findings, []);
    });
  }
}

test("early completion retains the actual first index after skipped holes", async () => {
  assert.equal((await high("createServer(() => [,0,1].some((item,index) => { if(index) readFileSync('live'); return true; }));")).length, 1);
  assert.deepEqual(await high("createServer(() => [0,1].some((item,index) => { if(index) readFileSync('unused'); return true; }));"), []);
});

test("a stopping callback still evaluates a default for the first undefined item", async () => {
  assert.equal((await high("createServer(() => [undefined,1].some((item = readFileSync('live')) => true));")).length, 1);
  assert.deepEqual(await high("createServer(() => [1,undefined].some((item = readFileSync('unused')) => true));"), []);
});

test("async and generator stopping results preserve invocation-time defaults", async () => {
  for (const callback of ["async (item = readFileSync('live')) => false", "function* (item = readFileSync('live')) { return false; }"]) {
    assert.equal((await high(`createServer(() => [undefined,1].some(${callback}));`)).length, 1);
    assert.deepEqual(await high(`createServer(() => [1,undefined].some(${callback}));`), []);
  }
});

test("bound callbacks retain their receiver and bound arguments when stopping", async () => {
  assert.equal((await high(`const receiver = { work() { readFileSync('live'); } };
    function callback(fixed,item) { this.work(); if(item) readFileSync('unused'); return true; }
    createServer(() => [0,1].some(callback.bind(receiver, 'bound')));`)).length, 1);
});

test("argument-dependent returns cannot acquire a shared constant completion", async () => {
  const findings = await high(`function callback(item, index, array) { if(index) readFileSync('live'); return item; }
    createServer(() => { [true,false].some(callback); [false,true].some(callback); });`);
  assert.equal(findings.length, 1);
});

test("a reassigned callback retains the replacement's continuing result", async () => {
  const setup = "let callback = item => { jobs.push(item); count++; return true; }; callback = item => { jobs.push(item); count++; return false; };";
  assert.equal((await audit(queues("[1,2].some(callback);", setup))).length, 2);
});

test("repeated calls reuse a wide callback's intrinsic completion proof", async () => {
  const source = repeats => `${http}
    const items = [0,1];
    function callback(item) { ${"if (unknown) { void item; }\n".repeat(180)} return true; }
    createServer(() => { ${"items.some(callback);\n".repeat(repeats)} });`;
  const measure = async repeats => {
    const take = AnalysisBudget.prototype.take; let work = 0;
    AnalysisBudget.prototype.take = function (count = 1) {
      if (this.label === "Request reachability") work += count;
      return take.call(this, count);
    };
    try { await audit(source(repeats), detectSyncIo); return work; }
    finally { AnalysisBudget.prototype.take = take; }
  };
  const first = await measure(80), doubled = await measure(160);
  assert.ok(doubled < first * 2.5, `${first} -> ${doubled}`);
});
