import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";

async function audit(source) {
  const root = await mkdtemp(join(tmpdir(), "scale-queue-bounds-"));
  try {
    await writeFile(join(root, "server.ts"), source);
    return await detectQueueBackpressure(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function boundedBatch(workerBody, { before = "", after = "", admission = "", bound = "10 - outstanding", drain, initial = "0", increment = "outstanding++" } = {}) {
  return `
    import { createServer } from 'node:http';
    const jobs = [];
    let outstanding = ${initial};
    function enqueue(job) { jobs.push(job); ${increment}; }
    function work(job) { ${workerBody} }
    ${before}
    setInterval(${drain ?? "() => work(jobs.shift())"}, 100);
    createServer(req => {
      ${admission}
      const count = Math.min(${bound}, Number(req.url.slice(1)));
      Array.from({ length: count }, (_, index) => enqueue(index));
      ${after}
    });
  `;
}

for (const worker of ["outstanding = 0;", "outstanding--;", "if (job !== null) outstanding--;"]) {
  test(`an empty tick or excess decrement cannot prove a remaining-capacity bound via ${worker}`, async () => {
    assert.equal((await audit(boundedBatch(worker))).length, 1);
  });
}

test("a producer-side reset invalidates a remaining-capacity bound", async () => {
  assert.equal((await audit(boundedBatch("", { after: "outstanding = 0;" }))).length, 1);
});

test("a destructuring reset invalidates a remaining-capacity bound", async () => {
  assert.equal((await audit(boundedBatch("", { after: "[outstanding] = [0];" }))).length, 1);
});

test("a second call to the drain worker invalidates its decrement evidence", async () => {
  assert.equal((await audit(boundedBatch("if (job !== undefined) outstanding--;", { after: "work(123);" }))).length, 1);
});

test("monotonic counters and a worker guarded on a present job retain the bound", async () => {
  assert.deepEqual(await audit(boundedBatch("")), []);
  assert.deepEqual(await audit(boundedBatch("", { initial: "-1" })), []);
  assert.deepEqual(await audit(boundedBatch("if (job !== undefined) outstanding--;")), []);
  assert.deepEqual(await audit(boundedBatch("outstanding--;", { drain: "() => { if (!jobs.length) return; work(jobs.shift()); }" })), []);
});

test("equivalent unit increments and guarded decrement forms retain a batch bound", async () => {
  const options = { increment: "outstanding = outstanding + 1" };
  assert.deepEqual(await audit(boundedBatch("if (job === undefined) return; outstanding--;", options)), []);
  assert.deepEqual(await audit(boundedBatch("if (job !== undefined) { outstanding--; console.log(job); }", options)), []);
});

for (const initial of ["-Infinity", "-1e100"]) {
  test(`a counter initialized to ${initial} cannot prove a remaining-capacity bound`, async () => {
    assert.equal((await audit(boundedBatch("", { initial }))).length, 1);
  });
}

test("a fixed clamp cannot restore a guard backed by a drifting counter", async () => {
  const options = { admission: "if (outstanding >= 10) return;", bound: "10" };
  for (const worker of ["outstanding = 0;", "outstanding--;"]) {
    assert.equal((await audit(boundedBatch(worker, options))).length, 1);
  }
  assert.deepEqual(await audit(boundedBatch("if (job !== undefined) outstanding--;", options)), []);
});

function twoQueues(dispatch, sharedProducer = true) {
  return `
    import { createServer } from 'node:http';
    const fast = [];
    const slow = [];
    let fastCount = 0;
    let slowCount = 0;
    ${sharedProducer ? `function enqueue(job) {
      fast.push(job); fastCount++;
      slow.push(job); slowCount++;
    }` : ""}
    function workFast(job) { if (job !== undefined) fastCount--; }
    function workSlow(job) { if (job !== undefined) slowCount--; }
    setInterval(() => workFast(fast.shift()), 10);
    setInterval(() => workSlow(slow.shift()), 1000);
    ${dispatch}
  `;
}

const dispatchBatch = "const size = Math.min(10, Number(req.url.slice(1))); Array.from({ length: size }, (_, i) => enqueue(i));";

test("a fast-queue guard cannot bound a slower queue fed by the same fixed-size batch", async () => {
  const findings = await audit(twoQueues(`createServer(req => { if (fastCount >= 10) return; ${dispatchBatch} });`));
  assert.equal(findings.length, 1);
  assert.match(findings[0].snippet, /slow\.push/);
});

for (const condition of [
  "full() === true", "Boolean(full())", "full() ?? false", "full() ? true : false", "!(full() ? false : true)",
  "full.call(null)", "Boolean(full.call(null))",
]) {
  test(`boolean guard ${condition} bounds only its own queue`, async () => {
    const findings = await audit(twoQueues(`
      function full() { return fastCount >= 10; }
      createServer(req => { if (${condition}) return; ${dispatchBatch} });
    `));
    assert.equal(findings.length, 1);
    assert.match(findings[0].snippet, /slow\.push/);
  });
}

for (const replacement of ["full.call", "Function.prototype.call"]) {
  test(`a replaced ${replacement} cannot establish a queue guard`, async () => {
    const findings = await audit(twoQueues(`
      function full() { return fastCount >= 10; }
      ${replacement} = () => false;
      createServer(req => { if (full.call(null)) return; ${dispatchBatch} });
    `));
    assert.equal(findings.length, 2);
  });
}

test("a truthy non-boolean result does not establish a strict boolean guard", async () => {
  const findings = await audit(twoQueues(`
    function full() { return 1 || fastCount >= 10; }
    createServer(req => { if (full() === true) return; ${dispatchBatch} });
  `));
  assert.equal(findings.length, 2);
});

test("a replaced global Boolean cannot establish a queue guard", async () => {
  const findings = await audit(twoQueues(`
    globalThis.Boolean = () => false;
    function full() { return fastCount >= 10; }
    createServer(req => { if (Boolean(full())) return; ${dispatchBatch} });
  `));
  assert.equal(findings.length, 2);
});

test("fixed-size batches inherit guards on both queues when each counter is checked", async () => {
  const findings = await audit(twoQueues(`createServer(req => { if (fastCount >= 10 || slowCount >= 10) return; ${dispatchBatch} });`));
  assert.deepEqual(findings, []);
});

test("a reversed comparison guards only the queue whose counter it checks", async () => {
  const findings = await audit(twoQueues(`createServer(req => { if (10 <= fastCount) return; ${dispatchBatch} });`));
  assert.equal(findings.length, 1);
  assert.match(findings[0].snippet, /slow\.push/);
});

test("requiring both queues to be full does not enforce either queue's capacity", async () => {
  const findings = await audit(twoQueues(`createServer(req => { if (fastCount >= 10 && slowCount >= 10) return; ${dispatchBatch} });`));
  assert.equal(findings.length, 2);
  assert.ok(findings.some(finding => /slow\.push/.test(finding.snippet)));
});

for (const [name, guard] of [
  ["an adjacent counter snapshot", "const countNow = fastCount; if (countNow >= 10) return;"],
  ["a negated comparison", "if (!(fastCount < 10)) return;"],
  ["logging before exit", "if (fastCount >= 10) { console.log('full'); return; }"],
  ["same-queue conjunction", "if (fastCount >= 10 && fastCount >= 20) return;"],
  ["chained counter snapshots", "const first = fastCount; const observed = first; if (observed >= 10) return;"],
  ["a snapshot with a second exit condition", "const observed = fastCount; if (observed >= 10 || req.url === '/disabled') return;"],
  ["read-only logging between snapshot and check", "const observed = fastCount; console.log(observed); if (observed >= 10) return;"],
  ["a synchronous guard helper", "function full() { return fastCount >= 10; } if (full()) return;"],
  ["a named immutable limit", "const MAX_PENDING = 10; if (fastCount >= MAX_PENDING) return;"],
  ["a nested synchronous guard helper", "function full() { return fastCount >= 10; } function allowed() { return !full(); } if (!allowed()) return;"],
]) {
  test(`${name} bounds only the queue it checks`, async () => {
    const findings = await audit(twoQueues(`createServer(req => { ${guard} ${dispatchBatch} });`));
    assert.equal(findings.length, 1);
    assert.match(findings[0].snippet, /slow\.push/);
  });
}

for (const body of [
  `if (fastCount < 10) { ${dispatchBatch} }`,
  `if (fastCount >= 10) console.log('full'); else { ${dispatchBatch} }`,
]) {
  test(`a capacity check on the selected branch keeps its queue identity in ${body}`, async () => {
    const findings = await audit(twoQueues(`createServer(req => { ${body} });`));
    assert.equal(findings.length, 1);
    assert.match(findings[0].snippet, /slow\.push/);
  });
}

test("a replaced guard helper cannot establish queue capacity", async () => {
  const findings = await audit(twoQueues(`createServer(req => {
    function full() { return fastCount >= 10; }
    full = () => false;
    if (full()) return;
    ${dispatchBatch}
  });`));
  assert.equal(findings.length, 2);
});

test("a replaced inner guard helper cannot establish queue capacity through a wrapper", async () => {
  const findings = await audit(twoQueues(`createServer(req => {
    function full() { return fastCount >= 10; }
    function allowed() { return !full(); }
    full = () => false;
    if (!allowed()) return;
    ${dispatchBatch}
  });`));
  assert.equal(findings.length, 2);
});

test("a guard helper can read a captured cap initialized before its request registration", async () => {
  const findings = await audit(twoQueues(`
    function full() { return fastCount >= LIMIT; }
    const LIMIT = 10;
    createServer(req => { if (full()) return; ${dispatchBatch} });
  `));
  assert.equal(findings.length, 1);
  assert.match(findings[0].snippet, /slow\.push/);
});

test("a later helper invocation can use a captured cap without crediting a registration before initialization", async () => {
  const findings = await audit(twoQueues(`
    function full() { return fastCount >= LIMIT; }
    createServer(req => { if (full()) return; ${dispatchBatch} });
    const LIMIT = 10;
    createServer(req => { if (full()) return; ${dispatchBatch} });
  `));
  assert.equal(findings.length, 2);
});

test("a batch can skip a capacity equality and leave both queues unbounded", async () => {
  const findings = await audit(twoQueues(`createServer(req => { if (fastCount === 10) return; ${dispatchBatch} });`));
  assert.equal(findings.length, 2);
});

for (const prefix of ["await pending;", "fastCount++;"]) {
  test(`a counter snapshot before ${prefix} does not establish admission`, async () => {
    const findings = await audit(twoQueues(`createServer(async req => {
      const countNow = fastCount;
      ${prefix}
      if (countNow >= 10) return;
      ${dispatchBatch}
    });`));
    assert.equal(findings.length, 2);
  });
}

test("a foreign queue guard inside a helper preserves an earlier guard on the actual queue", async () => {
  const findings = await audit(twoQueues(`
    function submit(req) { if (fastCount >= 10) return; ${dispatchBatch} }
    createServer(req => { if (slowCount >= 10) return; submit(req); });
  `));
  assert.deepEqual(findings, []);
});

test("a guard on one queue does not hide a direct append to a different queue", async () => {
  const source = twoQueues(`createServer(req => { if (fastCount >= 10) return;
    fast.push(req.url); fastCount++;
    slow.push(req.url); slowCount++;
  });`, false);
  const findings = await audit(source);
  assert.equal(findings.length, 1);
  assert.match(findings[0].snippet, /slow\.push/);
});

test("a mutated Math.min via an immutable mutator alias cannot prove a batch bound", async () => {
  const source = boundedBatch("if (job !== undefined) outstanding--;", {
    before: "const assign = Object.assign; const math = Math; assign(math, { min: (_, size) => size });",
    admission: "if (outstanding >= 10) return;",
    bound: "10",
  });
  assert.equal((await audit(source)).length, 1);
});

function sharedRoutes(guarded, sharedGuard = false, redundantCheck = false, sharedHelper = false, helperGuard = "full()", helperSize = 220, repeats = 350, queueCount = 220) {
  const labels = Array.from({ length: queueCount }, (_, index) => index);
  function or(first, last) {
    if (last - first === 1) return `count${first} >= 10`;
    const mid = (first + last) >>> 1;
    return `(${or(first, mid)} || ${or(mid, last)})`;
  }
  const source = `
    import { createServer } from 'node:http';
    ${labels.map(index => `const q${index} = []; let count${index} = 0;`).join("\n")}
    function work(job) {}
    function produce() {
      ${labels.map(index => `q${index}.push(1); count${index}++;`).join("\n")}
    }
    ${labels.map(index => `setInterval(() => work(q${index}.shift()), 100);`).join("\n")}
    ${sharedHelper
      ? `function full() { return ${or(0, helperSize)}; }
        function alsoFull() { return ${or(0, helperSize)}; }
        createServer(req => { ${`if (${helperGuard}) return; produce();\n`.repeat(repeats)} });`
      : sharedGuard
      ? `createServer(() => { if (${or(0, labels.length)}) return; ${`${redundantCheck ? "if(count0 >= 10) return; " : ""}produce();\n`.repeat(350)} });`
      : "createServer(() => produce());\n".repeat(350)}
    ${guarded ? `createServer(async () => { await load(); if (${or(0, labels.length)}) return; produce(); });` : ""}
  `;
  return { source, expected: sharedGuard ? 0 : labels.length };
}

test("many calls under one unchanged guard reuse admission and caller facts", async () => {
  const { source, expected } = sharedRoutes(false, true);
  assert.equal((await audit(source)).length, expected);
});

test("redundant counter checks do not divide an unchanged shared admission segment", async () => {
  const { source, expected } = sharedRoutes(false, true, true);
  assert.equal((await audit(source)).length, expected);
});

test("repeated calls to a wide guard helper reuse its applied capacity checks", async () => {
  const { source } = sharedRoutes(false, false, false, true);
  assert.deepEqual(await audit(source), []);
});

for (const condition of ["req.url === '/maintenance'", "count0 === 11"]) {
  test(`a wide helper combined with ${condition} shares capacity checks across callers`, async () => {
    const { source } = sharedRoutes(false, false, false, true, `full() || ${condition}`);
    assert.deepEqual(await audit(source), []);
  });
}

test("a repeated compound guard caches the additional capacity fact beside a wide helper", async () => {
  const { source } = sharedRoutes(false, false, false, true, "full() || count219 >= 10", 219);
  assert.deepEqual(await audit(source), []);
});

test("a repeated compound guard shares an unsupported comparison on a separate queue", async () => {
  const { source } = sharedRoutes(false, false, false, true, "full() || count220 === 11", 220, 350, 221);
  const findings = await audit(source);
  assert.equal(findings.length, 1);
  assert.match(findings[0].snippet, /q220\.push/);
});

for (const [condition, queueCount] of [
  ["count220 === 11 || count221 === 11", 222],
  ["check(count220, count221)", 222],
  ["req.url != null && count220 === 11", 221],
]) {
  test(`a wide helper reuses compound mention-only facts from ${condition}`, async () => {
    const { source } = sharedRoutes(false, false, false, true, `full() || (${condition})`, 220, 350, queueCount);
    const findings = await audit(source);
    assert.equal(findings.length, queueCount - 220);
    assert.match(findings[0].snippet, /q220\.push/);
    if (queueCount === 222) assert.match(findings[1].snippet, /q221\.push/);
  });
}

test("repeated conjunctions reuse intersections of the same wide helper bounds", async () => {
  const { source } = sharedRoutes(false, false, false, true, "full() && alsoFull()");
  assert.deepEqual(await audit(source), []);
});

test("repeated disjunctions reuse subset comparisons between equivalent wide helpers", async () => {
  const { source } = sharedRoutes(false, false, false, true, "full() || alsoFull()", 220, 700);
  assert.deepEqual(await audit(source), []);
});

test("a repeated helper check refreshes capacity after suspension", async () => {
  assert.deepEqual(await audit(twoQueues(`
    function full() { return fastCount >= 10 || slowCount >= 10; }
    createServer(async req => {
      if (full()) return;
      await load();
      if (full()) return;
      ${dispatchBatch}
    });
  `)), []);
});

test("repeated checks reuse normalization of a shared wrapped capacity predicate", async () => {
  const threshold = `${"(".repeat(120)}outstanding >= 10${")".repeat(120)}`;
  assert.deepEqual(await audit(`
    import { createServer } from 'node:http';
    const jobs = [];
    let outstanding = 0;
    function produce() { jobs.push(1); outstanding++; }
    function full() { return ${threshold}; }
    function work(job) {}
    setInterval(() => work(jobs.shift()), 100);
    createServer(() => {
      ${"if (full()) return; produce();\n".repeat(2500)}
    });
  `), []);
});

test("repeated checks do not reevaluate the same multi-term guard helper", async () => {
  const predicate = Array.from({ length: 40 }, () => "outstanding >= 10").join(" || ");
  assert.deepEqual(await audit(`
    import { createServer } from 'node:http';
    const jobs = [];
    let outstanding = 0;
    function produce() { jobs.push(1); outstanding++; }
    function full() { return ${predicate}; }
    function work(job) {}
    setInterval(() => work(jobs.shift()), 100);
    createServer(() => {
      ${"if (full()) return; produce();\n".repeat(2500)}
    });
  `), []);
});

for (const guarded of [false, true]) {
  test(`independent counters share unguarded routes ${guarded ? "even with an async route checking all counters" : "when no route checks them"}`, async () => {
    const { source, expected } = sharedRoutes(guarded);
    assert.equal((await audit(source)).length, expected);
  });
}
