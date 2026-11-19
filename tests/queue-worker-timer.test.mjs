import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";

const producer = `
import { createServer } from "node:http";
const jobs = [];
function work(job) {}
createServer(req => jobs.push(req.url));
`;
const registration = "setInterval(() => work(jobs.shift()), 100)";

async function audit(source, otherFiles = {}) {
  const root = await mkdtemp(join(tmpdir(), "scale-worker-timer-"));
  try {
    for (const [name, text] of Object.entries({ "server.js": source, ...otherFiles })) {
      await writeFile(join(root, name), text);
    }
    return await detectQueueBackpressure(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const [name, setup] of Object.entries({
  "unchanged let handle": `let timer = ${registration}; clearInterval(timer);`,
  "chained const aliases": `const timer = ${registration}; const other = timer; const alias = (other); clearInterval(alias);`,
  "qualified clearTimeout": `const timer = ${registration}; globalThis.clearTimeout(timer);`,
  "global object alias": `const timer = ${registration}; const host = globalThis; const alias = host; alias.clearInterval(timer);`,
  "cancellation in a second declaration initializer": `const timer = ${registration}, stopped = clearInterval(timer);`,
  "cancellation in a synchronous block": `const timer = ${registration}; { const alias = timer; clearInterval(alias); }`,
  "snapshot before original handle reassignment": `let timer = ${registration}; const captured = timer; timer = undefined; clearInterval(captured);`,
  "snapshot before a destructuring write": `let timer = ${registration}; const captured = timer; ([timer = undefined] = []); clearInterval(captured);`,
})) {
  test(`startup cancellation recognizes ${name}`, async () => {
    const findings = await audit(producer + setup);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /Startup cancels/);
  });
}

for (const [name, setup] of Object.entries({
  "reassignment": `let timer = ${registration}; timer = {}; clearInterval(timer);`,
  "destructuring assignment": `let timer = ${registration}; ({ timer } = replacement); clearInterval(timer);`,
  "snapshot after original handle reassignment": `let timer = ${registration}; timer = undefined; const captured = timer; clearInterval(captured);`,
  "write in a helper invoked before the snapshot": `let timer = ${registration}; reset(); const alias = timer; clearInterval(alias); function reset() { timer = undefined; }`,
  "late binding alias": `const timer = ${registration}; clearInterval(alias); const alias = timer;`,
  "conditional cancellation": `const timer = ${registration}; if (enabled) { clearInterval(timer); }`,
  "global object alias before initialization": `const timer = ${registration}; host.clearInterval(timer); const host = globalThis;`,
})) {
  test(`startup cancellation stays uncertain with ${name}`, async () => {
    const findings = await audit(producer + setup);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /dequeues at most one job/);
  });
}

test("a side-effect import replacing clearInterval cannot prove cancellation", async () => {
  const findings = await audit(
    'import "./patch.js";\n' + producer + `const timer = ${registration}; clearInterval(timer);`,
    { "patch.js": 'globalThis.clearInterval = () => {};' },
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /dequeues at most one job/);
});

for (const assignment of [
  "[globalThis.clearInterval] = [() => {}];",
  "({ cancel: globalThis.clearInterval = () => {} } = {});",
]) {
  test(`a destructuring write cannot prove cancellation: ${assignment}`, async () => {
    const findings = await audit(
      'import "./patch.js";\n' + producer + `const timer = ${registration}; clearInterval(timer);`,
      { "patch.js": assignment },
    );
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /dequeues at most one job/);
  });
}

test("a configured clearTimeout replacement does not invalidate genuine clearInterval", async () => {
  const findings = await audit(
    'import "./patch.js";\n' + producer + `const timer = ${registration}; clearInterval(timer);`,
    { "patch.js": 'globalThis["clearTimeout"] = () => {};' },
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /Startup cancels/);
});

for (const worker of ["() => {}", "async () => {}"]) {
  test(`repeated timer registrations reuse resolution of wrapped ${worker}`, async () => {
    const wrappers = 250;
    const source = `const jobs = []; const work = ${"(".repeat(wrappers)}${worker}${")".repeat(wrappers)};\n`
      + `${registration};\n`.repeat(1000);
    assert.deepEqual(await audit(source), []);
  });
}

test("nested assignment defaults reuse the destructuring write scan", async () => {
  let target = "other";
  for (let i = 0; i < 150; i++) target = `[${target} = []]`;
  const source = `const jobs = []; let timer = ${registration}; function work(job) {} let other;\n`
    + `${target} = [];\n`.repeat(12);
  assert.deepEqual(await audit(source), []);
});

test("many writes reuse startup ordering for the same nested block", async () => {
  const source = `const jobs = []; let timer = ${registration}; function work(job) {}\n`
    + "{".repeat(150) + "timer = undefined;\n".repeat(1800) + "}".repeat(150);
  assert.deepEqual(await audit(source), []);
});

for (const assignment of [
  "[setInterval] = [() => ({})];",
  "({ setInterval } = { setInterval: () => ({}) });",
  "const host = globalThis; [host.setInterval] = [() => ({})];",
]) {
  test(`destructuring a host registration API invalidates drain evidence: ${assignment}`, async () => {
    const findings = await audit('import "./patch.js";\n' + producer + `${registration};`, { "patch.js": assignment });
    assert.deepEqual(findings, []);
  });
}

test("a lexical setInterval assignment does not alter the host function", async () => {
  const findings = await audit('import "./patch.js";\n' + producer + `${registration};`, {
    "patch.js": "let setInterval; ({ setInterval } = {}); export {};",
  });
  assert.equal(findings.length, 1);
});

test("an immutable global alias can replace clearInterval in an imported module", async () => {
  const findings = await audit(
    'import "./patch.js";\n' + producer + `const timer = ${registration}; clearInterval(timer);`,
    { "patch.js": "const host = globalThis; const alias = host; alias.clearInterval = () => {};" },
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /dequeues at most one job/);
});

test("a local lookalike alias does not invalidate host cancellation", async () => {
  const findings = await audit(producer + `
    const timer = ${registration};
    { const globalThis = {}; const host = globalThis; host.clearInterval = () => {}; }
    clearInterval(timer);
  `);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /Startup cancels/);
});

test("a CommonJS startup return skips later cancellation", async () => {
  const findings = await audit(producer.replace('import { createServer } from "node:http";', 'const { createServer } = require("node:http");')
    + `const timer = ${registration}; { return; } clearInterval(timer);`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /dequeues at most one job/);
});

test("a CommonJS startup return prevents a later bare interval from proving a drain", async () => {
  const source = producer.replace('import { createServer } from "node:http";', 'const { createServer } = require("node:http");');
  assert.deepEqual(await audit(source + `return; ${registration};`), []);
  const findings = await audit(source + `${registration}; return;`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /dequeues at most one job/);
});

for (const mutation of [
  "Object.assign(host, { clearInterval: () => {} });",
  'Object.defineProperty(host, "clearInterval", { value: () => {} });',
  'Reflect.set(host, "clearInterval", () => {});',
]) {
  test(`cancellation cannot be established after ${mutation}`, async () => {
    const findings = await audit(
      'import "./patch.js";\n' + producer + `const timer = ${registration}; clearInterval(timer);`,
      { "patch.js": "const host = globalThis; " + mutation },
    );
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /dequeues at most one job/);
  });
}

test("a host mutator replacing only clearTimeout preserves clearInterval evidence", async () => {
  const findings = await audit(producer + `
    const timer = ${registration};
    const host = globalThis;
    Object.assign(host, { clearTimeout: () => {} });
    host.clearInterval(timer);
  `);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /Startup cancels/);
});

test("a host mutator replacing setInterval invalidates the proposed drain", async () => {
  const findings = await audit(
    'import "./patch.js";\n' + producer + `${registration};`,
    { "patch.js": "const host = globalThis; Object.assign(host, { setInterval: () => ({}) });" },
  );
  assert.deepEqual(findings, []);
});

test("an empty finally does not hide synchronous cancellation", async () => {
  const findings = await audit(producer + `const timer = ${registration}; try { clearInterval(timer); } finally {}`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /Startup cancels/);
});

for (const branch of ["if (true) return;", "if (enabled) { return; } else { return; }"]) {
  test(`a definitely abrupt CommonJS branch blocks a later interval: ${branch}`, async () => {
    const source = producer.replace('import { createServer } from "node:http";', 'const { createServer } = require("node:http");');
    assert.deepEqual(await audit(source + `${branch} ${registration};`), []);
    const findings = await audit(source + `${registration}; ${branch}`);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /dequeues at most one job/);
  });
}

for (const [name, setup] of Object.entries({
  "literal true branch": "if (true) { clearInterval(timer); }",
  "native function alias": "const cancel = clearInterval; cancel(timer);",
  "hoisted synchronous helper": "stop(timer); function stop(handle) { clearInterval(handle); }",
  "immutable synchronous helper": "const stop = () => clearInterval(timer); stop();",
})) {
  test(`startup cancellation recognizes ${name}`, async () => {
    const findings = await audit(producer + `const timer = ${registration}; ${setup}`);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /Startup cancels/);
  });
}

for (const [name, setup] of Object.entries({
  "literal false branch": "if (false) { clearInterval(timer); }",
  "helper reassignment": "function stop(handle) { clearInterval(handle); } stop = () => {}; stop(timer);",
  "deferred helper": "async function stop(handle) { await pending; clearInterval(handle); } stop(timer);",
  "locally shadowed alias": "function clearInterval() {} const cancel = clearInterval; cancel(timer);",
})) {
  test(`startup cancellation stays uncertain with ${name}`, async () => {
    const findings = await audit(producer + `const timer = ${registration}; ${setup}`);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /dequeues at most one job/);
  });
}

test("a native mutator alias can replace clearInterval", async () => {
  const findings = await audit(
    'import "./patch.js";\n' + producer + `const timer = ${registration}; clearInterval(timer);`,
    { "patch.js": "const assign = Object.assign; assign(globalThis, { clearInterval: () => {} });" },
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /dequeues at most one job/);
});

for (const [name, mutation] of Object.entries({
  "bracket Object.assign": 'Object["assign"](globalThis, { clearInterval() {} });',
  "an Object alias": "const object = Object; object.assign(globalThis, { clearInterval() {} });",
  "bracket Reflect.set": 'Reflect["set"](globalThis, "clearInterval", () => {});',
  "an immutable property key": 'const key = "clearInterval"; Object.defineProperty(globalThis, key, { value() {} });',
})) {
  test(`${name} invalidates native cancellation evidence`, async () => {
    const findings = await audit(
      'import "./patch.js";\n' + producer + `const timer = ${registration}; clearInterval(timer);`,
      { "patch.js": mutation },
    );
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /dequeues at most one job/);
  });
}

test("cancellation after a possibly abrupt CommonJS branch is uncertain", async () => {
  const source = producer.replace('import { createServer } from "node:http";', 'const { createServer } = require("node:http");');
  const findings = await audit(source + `const timer = ${registration}; if (enabled) return; clearInterval(timer);`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /dequeues at most one job/);
});

for (const [name, startup] of Object.entries({
  "a plain startup block": `{ ${registration}; }`,
  "a definitely selected startup branch": `if (true) { ${registration}; }`,
  "an unreachable alternative in startup": `if (false) { throw 0; } else { ${registration}; }`,
})) {
  test(`a recurring interval is recognized inside ${name}`, async () => {
    const findings = await audit(producer + startup);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /dequeues at most one job/);
  });
}

test("a syntactically present interval in an unselected branch proves no drain", async () => {
  assert.deepEqual(await audit(producer + `if (false) { ${registration}; }`), []);
});

test("a selected CommonJS switch case that returns prevents a later interval", async () => {
  const source = producer.replace('import { createServer } from "node:http";', 'const { createServer } = require("node:http");');
  assert.deepEqual(await audit(source + `switch (0) { case 0: return; } ${registration};`), []);
  const findings = await audit(source + `switch (1) { case 0: return; case 1: break; } ${registration};`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /dequeues at most one job/);
});

for (const [name, startup] of Object.entries({
  "direct cancellation before a replacement": "clearInterval(timer); globalThis.clearInterval = () => {};",
  "a captured native cancellation after a replacement": "const cancel = clearInterval; globalThis.clearInterval = () => {}; cancel(timer);",
  "native property cancellation before an aliased mutator": "globalThis.clearInterval(timer); const assign = Object.assign; assign(globalThis, { clearInterval: () => {} });",
  "a captured native property after an aliased mutator": "const cancel = globalThis.clearInterval; const assign = Object.assign; assign(globalThis, { clearInterval: () => {} }); cancel(timer);",
  "both branches cancel the same timer": "if (enabled) { clearInterval(timer); } else { clearTimeout(timer); }",
})) {
  test(`startup cancellation recognizes ${name}`, async () => {
    const findings = await audit(producer + `const timer = ${registration}; ${startup}`);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /Startup cancels/);
  });
}

test("capturing a host cancellation function after it is replaced does not prove cancellation", async () => {
  const findings = await audit(producer + `const timer = ${registration}; globalThis.clearInterval = () => {};
    const cancel = clearInterval; cancel(timer);`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /dequeues at most one job/);
});

test("both cancellation branches still require synchronous startup", async () => {
  const findings = await audit(producer + `const timer = ${registration}; if (await enabled) {
    clearInterval(timer);
  } else { clearTimeout(timer); }`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /dequeues at most one job/);
});

test("repeated calls to a wrapped cancellation helper reuse its summary", async () => {
  const wrapped = "(".repeat(80) + "clearInterval" + ")".repeat(80);
  const findings = await audit(producer + `const timer = ${registration}; function stop(handle) { ${wrapped}(handle); }
    ${"stop(timer);\n".repeat(2_500)}`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /Startup cancels/);
});

for (const [name, setup] of Object.entries({
  "native unref chaining": `${registration}.unref();`,
  "hoisted registration helper": `start(); function start() { ${registration}; }`,
  "immutable registration helper": `const start = () => ${registration}.unref(); start();`,
  "unrelated unref replacement": `const resource = {}; resource.unref = () => {}; ${registration}.unref();`,
})) {
  test(`a recurring drain is recognized with ${name}`, async () => {
    const findings = await audit(producer + setup);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /dequeues at most one job/);
  });
}

test("a chained native unref result retains handle identity for cancellation", async () => {
  const findings = await audit(producer + `const timer = ${registration}.unref(); clearInterval(timer);`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /Startup cancels/);
});

for (const [name, setup] of Object.entries({
  "conditional helper invocation": `function start() { ${registration}; } if (enabled) start();`,
  "replaced registration helper": `function start() { ${registration}; } start = () => {}; start();`,
  "deferred registration helper": `const start = async () => { await pending; ${registration}; }; start();`,
  "replaced native timer": `globalThis.setInterval = () => ({}); ${registration}.unref();`,
  "replaced timeout-prototype method": `const probe = setInterval(() => {}, 100);
    const timerPrototype = Object.getPrototypeOf(probe); timerPrototype.unref = () => {};
    ${registration}.unref();`,
})) {
  test(`startup does not establish a drain with ${name}`, async () => {
    assert.deepEqual(await audit(producer + setup), []);
  });
}

for (const exit of ["{ return; }", "if (true) return;"]) {
  test(`a nested exit in the selected CommonJS case skips interval registration: ${exit}`, async () => {
    const source = producer.replace('import { createServer } from "node:http";', 'const { createServer } = require("node:http");');
    assert.deepEqual(await audit(source + `switch (0) { case 0: ${exit} } ${registration};`), []);
    const findings = await audit(source + `switch (1) { case 0: ${exit} case 1: break; } ${registration};`);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /dequeues at most one job/);
  });
}

test("both branches can exit a selected CommonJS case before an interval", async () => {
  const source = producer.replace('import { createServer } from "node:http";', 'const { createServer } = require("node:http");');
  assert.deepEqual(await audit(source + `switch (0) { case 0: if (enabled) return; else return; } ${registration};`), []);
  const findings = await audit(source + `switch (0) { case 0: if (enabled) { break; return; } else return; } ${registration};`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /dequeues at most one job/);
});

test("a startup helper can register a drain before logging", async () => {
  const findings = await audit(producer + `function start() { ${registration}; console.log("ready"); } start();`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /dequeues at most one job/);
});

test("a timer returned by a startup helper retains its cancellation identity", async () => {
  const setup = `function start() { return ${registration}; } const timer = start();`;
  const active = await audit(producer + setup);
  assert.equal(active.length, 1);
  assert.match(active[0].message, /dequeues at most one job/);
  const cancelled = await audit(producer + setup + "clearInterval(timer);");
  assert.equal(cancelled.length, 1);
  assert.match(cancelled[0].message, /Startup cancels/);
});

test("startup helpers that discard an interval handle cannot return a cancellable handle", async () => {
  const findings = await audit(producer + `const start = () => void ${registration}; const discarded = start(); clearInterval(discarded);`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /dequeues at most one job/);
});

test("an immutable patch alias can replace the timer prototype's unref method", async () => {
  const setup = `const probe = setInterval(() => {}, 100);
    clearInterval(probe);
    const prototype = Object.getPrototypeOf(probe);
    const patch = { unref() { clearInterval(this); return this; } };
    const alias = patch;
    Object.assign(prototype, alias);
    ${registration}.unref();`;
  assert.deepEqual(await audit(producer + setup), []);
});

test("an immutable patch alias to an unrelated property preserves the native unref evidence", async () => {
  const setup = `const probe = setInterval(() => {}, 100);
    clearInterval(probe);
    const prototype = Object.getPrototypeOf(probe);
    const patch = { label: "queue timer" };
    Object.assign(prototype, patch);
    ${registration}.unref();`;
  const findings = await audit(producer + setup);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /dequeues at most one job/);
});

test("a startup helper can return its local interval handle", async () => {
  const setup = `function start() { const handle = ${registration}; return handle; } const timer = start();`;
  const active = await audit(producer + setup);
  assert.equal(active.length, 1);
  assert.match(active[0].message, /dequeues at most one job/);
  const cancelled = await audit(producer + setup + "clearInterval(timer);");
  assert.equal(cancelled.length, 1);
  assert.match(cancelled[0].message, /Startup cancels/);
});

for (const [name, patch] of Object.entries({
  "later property write": `const patch = {}; const alias = patch;
    alias.unref = function () { clearInterval(this); return this; };
    Object.assign(prototype, patch);`,
  "spread property": `const patch = { unref() { clearInterval(this); return this; } };
    Object.assign(prototype, { ...patch });`,
  "immutable computed name": `const key = "unref";
    Object.assign(prototype, { [key]() { clearInterval(this); return this; } });`,
})) {
  test(`a prototype patch can replace unref through ${name}`, async () => {
    const setup = `const probe = setInterval(() => {}, 100);
      clearInterval(probe);
      const prototype = Object.getPrototypeOf(probe);
      ${patch}
      ${registration}.unref();`;
    assert.deepEqual(await audit(producer + setup), []);
  });
}

test("repeated assignments reuse the shape of a shared wide timer patch", async () => {
  const properties = Array.from({ length: 250 }, (_, index) => `property${index}: true`).join(",");
  const setup = `const probe = setInterval(() => {}, 100);
    clearInterval(probe);
    const prototype = Object.getPrototypeOf(probe);
    const patch = { ${properties} };
    ${"Object.assign(prototype, patch);\n".repeat(1_000)}
    ${registration}.unref();`;
  const findings = await audit(producer + setup);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /dequeues at most one job/);
});

test("a helper can register its own named drain and return the local handle", async () => {
  const findings = await audit(producer + `function start() {
    function drain() { work(jobs.shift()); }
    const handle = setInterval(drain, 100);
    return handle;
  }
  const timer = start();
  clearInterval(timer);`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /Startup cancels/);
});

for (const [name, mutation] of Object.entries({
  "Object.assign": `Object.assign(patch, { unref() { clearInterval(this); return this; } });`,
  "an aliased defineProperty": `const define = Object.defineProperty;
    define(patch, "unref", { enumerable: true, value() { clearInterval(this); return this; } });`,
  "a copied source that gains unref": `const source = {};
    Reflect.set(source, "unref", function () { clearInterval(this); return this; });
    Object.assign(patch, source);`,
})) {
  test(`prototype patch shape accounts for ${name}`, async () => {
    const setup = `const probe = setInterval(() => {}, 100);
      clearInterval(probe);
      const prototype = Object.getPrototypeOf(probe);
      const patch = {};
      ${mutation}
      Object.assign(prototype, patch);
      ${registration}.unref();`;
    assert.deepEqual(await audit(producer + setup), []);
  });
}

test("native mutators adding unrelated keys preserve the timer patch proof", async () => {
  const setup = `const probe = setInterval(() => {}, 100);
    clearInterval(probe);
    const prototype = Object.getPrototypeOf(probe);
    const patch = {};
    Object.defineProperty(patch, "label", { value: "timer", enumerable: true });
    Object.assign(patch, { description: "drain" });
    Object.assign(prototype, patch);
    ${registration}.unref();`;
  const findings = await audit(producer + setup);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /dequeues at most one job/);
});

test("repeated timer prototype patches reuse a deeply wrapped registration proof", async () => {
  const wrapped = "(".repeat(120) + "setInterval(() => {}, 1000)" + ")".repeat(120);
  const setup = `const probe = ${wrapped}.unref();
    clearInterval(probe);
    const prototype = Object.getPrototypeOf(probe);
    const patch = { label: "timer" };
    ${"Object.assign(prototype, patch);\n".repeat(2_500)}
    ${registration}.unref();`;
  const findings = await audit(producer + setup);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /dequeues at most one job/);
});

test("a helper-returned interval can identify a patched timer prototype", async () => {
  const setup = `function makeProbe() { return setInterval(() => {}, 1000); }
    const probe = makeProbe();
    clearInterval(probe);
    const prototype = Object.getPrototypeOf(probe);
    Object.assign(prototype, { unref() { clearInterval(this); return this; } });
    ${registration}.unref();`;
  assert.deepEqual(await audit(producer + setup), []);
});

for (const [name, lookup, copy] of [
  ["Reflect.getPrototypeOf", "const prototype = Reflect.getPrototypeOf(probe);", "Object.assign"],
  ["an aliased Object.getPrototypeOf", "const get = Object.getPrototypeOf; const prototype = get(probe);", "Object.assign"],
  ["bracket-form Object.assign", "const prototype = Object.getPrototypeOf(probe);", 'Object["assign"]'],
]) {
  test(`timer patch mutations recognize ${name}`, async () => {
    const setup = `const probe = setInterval(() => {}, 100);
      clearInterval(probe);
      ${lookup}
      const patch = {};
      ${copy}(patch, { unref() { clearInterval(this); return this; } });
      ${copy}(prototype, patch);
      ${registration}.unref();`;
    assert.deepEqual(await audit(producer + setup), []);
  });
}

for (const [name, copy] of [
  ["a direct call", "Object.assign(prototype, patch);"],
  ["a variable initializer", "const result = Object.assign(prototype, patch);"],
  ["an intermediate spread", "const snapshot = { ...patch }; Object.assign(prototype, snapshot);"],
]) {
  test(`mutating a patch after ${name} leaves the timer prototype unchanged`, async () => {
    const setup = `const probe = setInterval(() => {}, 100);
      clearInterval(probe);
      const prototype = Object.getPrototypeOf(probe);
      const patch = {};
      ${copy}
      Object.assign(patch, { unref() { clearInterval(this); return this; } });
      ${registration}.unref();`;
    assert.equal((await audit(producer + setup)).length, 1);
  });
}

test("Object.assign skips a non-enumerable timer patch property", async () => {
  const setup = `const probe = setInterval(() => {}, 100);
    clearInterval(probe);
    const prototype = Object.getPrototypeOf(probe);
    const patch = {};
    Object.defineProperty(patch, "unref", {
      enumerable: false,
      value() { clearInterval(this); return this; },
    });
    Object.assign(prototype, patch);
    ${registration}.unref();`;
  assert.equal((await audit(producer + setup)).length, 1);
});

test("successive timer patch versions reuse the verified write prefix", async () => {
  const setup = `const probe = setInterval(() => {}, 100);
    clearInterval(probe);
    const prototype = Object.getPrototypeOf(probe);
    const patch = {};
    ${"Object.assign(patch, { label: 1 }); Object.assign(prototype, patch);\n".repeat(750)}
    ${registration}.unref();`;
  const findings = await audit(producer + setup);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /dequeues at most one job/);
});

test("a later enumerable write invalidates safe versions of a shared patch", async () => {
  const setup = `const probe = setInterval(() => {}, 100);
    clearInterval(probe);
    const prototype = Object.getPrototypeOf(probe);
    const patch = {};
    Object.assign(patch, { label: 1 });
    Object.assign(prototype, patch);
    Object.defineProperties(patch, {
      unref: { value() { clearInterval(this); return this; }, enumerable: true },
    });
    Object.assign(prototype, patch);
    ${registration}.unref();`;
  assert.deepEqual(await audit(producer + setup), []);
});

test("Object.assign skips non-enumerable timer properties from Object.defineProperties", async () => {
  const setup = `const probe = setInterval(() => {}, 100);
    clearInterval(probe);
    const prototype = Object.getPrototypeOf(probe);
    const patch = {};
    Object.defineProperties(patch, {
      unref: { value() { clearInterval(this); return this; } },
      label: { value: "timer", enumerable: true },
    });
    Object.assign(prototype, patch);
    ${registration}.unref();`;
  assert.equal((await audit(producer + setup)).length, 1);
});

test("Object.defineProperties directly replaces a prototype method regardless of enumeration", async () => {
  const setup = `const probe = setInterval(() => {}, 100);
    clearInterval(probe);
    const prototype = Object.getPrototypeOf(probe);
    Object.defineProperties(prototype, {
      unref: { value() { clearInterval(this); return this; } },
    });
    ${registration}.unref();`;
  assert.deepEqual(await audit(producer + setup), []);
});

test("repeated Object.defineProperties calls reuse an unchanged descriptor map", async () => {
  const descriptors = Array.from({ length: 250 }, (_, i) => `property${i}: { value: 1 }`).join(", ");
  const setup = `const probe = setInterval(() => {}, 100);
    clearInterval(probe);
    const prototype = Object.getPrototypeOf(probe);
    const patch = {};
    const descriptors = { ${descriptors} };
    ${"Object.defineProperties(patch, descriptors);\n".repeat(1_000)}
    Object.assign(prototype, patch);
    ${registration}.unref();`;
  const findings = await audit(producer + setup);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /dequeues at most one job/);
});

for (const [name, write] of [
  ["array destructuring", "[patch.unref] = [cancel];"],
  ["object destructuring", "({ stop: patch.unref } = { stop: cancel });"],
  ["nested destructuring defaults", "[{ stop: patch.unref = cancel }] = [{}];"],
]) {
  test(`a timer patch tracks ${name}`, async () => {
    const setup = `const probe = setInterval(() => {}, 100);
      clearInterval(probe);
      const prototype = Object.getPrototypeOf(probe);
      const patch = {};
      function cancel() { clearInterval(this); return this; }
      ${write}
      Object.assign(prototype, patch);
      ${registration}.unref();`;
    assert.deepEqual(await audit(producer + setup), []);
  });
}

test("destructuring into a patch after copying it does not change the timer prototype", async () => {
  const setup = `const probe = setInterval(() => {}, 100);
    clearInterval(probe);
    const prototype = Object.getPrototypeOf(probe);
    const patch = {};
    Object.assign(prototype, patch);
    [patch.unref] = [function () { clearInterval(this); return this; }];
    ${registration}.unref();`;
  assert.equal((await audit(producer + setup)).length, 1);
});

for (const [name, definition, expected] of [
  ["aliased descriptor map", `const descriptors = { unref: { value() { clearInterval(this); return this; } } };
    Object.defineProperties(patch, descriptors);`, 1],
  ["aliased descriptor", `const unref = { value() { clearInterval(this); return this; } };
    Object.defineProperties(patch, { unref });`, 1],
  ["falsy enumeration", `Object.defineProperties(patch, {
    unref: { enumerable: 0, value() { clearInterval(this); return this; } },
  });`, 1],
  ["enumeration changed through an alias", `const unref = { value() { clearInterval(this); return this; } };
    const descriptor = unref;
    descriptor.enumerable = true;
    Object.defineProperties(patch, { unref });`, 0],
]) {
  test(`timer patch copying respects ${name}`, async () => {
    const setup = `const probe = setInterval(() => {}, 100);
      clearInterval(probe);
      const prototype = Object.getPrototypeOf(probe);
      const patch = {};
      ${definition}
      Object.assign(prototype, patch);
      ${registration}.unref();`;
    assert.equal((await audit(producer + setup)).length, expected);
  });
}

for (const [name, definition, expected] of [
  ["a nested descriptor enumeration write", `const descriptors = { unref: { value() { clearInterval(this); return this; } } };
    descriptors.unref.enumerable = true;
    Object.defineProperties(patch, descriptors);`, 0],
  ["a nested descriptor mutator call", `const descriptors = { unref: { value() { clearInterval(this); return this; } } };
    Object.assign(descriptors.unref, { enumerable: true });
    Object.defineProperties(patch, descriptors);`, 0],
  ["a non-enumerable entry added to a descriptor map", `const descriptors = {};
    descriptors.unref = { value() { clearInterval(this); return this; } };
    Object.defineProperties(patch, descriptors);`, 1],
  ["a descriptor added and then changed", `const descriptors = {};
    descriptors.unref = { value() { clearInterval(this); return this; } };
    descriptors.unref.enumerable = true;
    Object.defineProperties(patch, descriptors);`, 0],
]) {
  test(`timer patch copying respects ${name}`, async () => {
    const setup = `const probe = setInterval(() => {}, 100);
      clearInterval(probe);
      const prototype = Object.getPrototypeOf(probe);
      const patch = {};
      ${definition}
      Object.assign(prototype, patch);
      ${registration}.unref();`;
    assert.equal((await audit(producer + setup)).length, expected);
  });
}

test("repeated Object.defineProperty calls reuse an unchanged wide descriptor", async () => {
  const fields = Array.from({ length: 250 }, (_, i) => `property${i}: 1`).join(", ");
  const setup = `const probe = setInterval(() => {}, 100);
    clearInterval(probe);
    const prototype = Object.getPrototypeOf(probe);
    const patch = {};
    const descriptor = { value: 1, ${fields} };
    ${"Object.defineProperty(patch, 'unref', descriptor);\n".repeat(1_000)}
    Object.assign(prototype, patch);
    ${registration}.unref();`;
  assert.equal((await audit(producer + setup)).length, 1);
});

for (const [name, definition, expected] of [
  ["enumeration changed through a destructured descriptor", `const descriptors = { unref: { value() { clearInterval(this); return this; } } };
    const { unref: descriptor } = descriptors;
    descriptor.enumerable = true;
    Object.defineProperties(patch, descriptors);`, 0],
  ["a descriptor passed through a member", `const bag = { unref: { value() { clearInterval(this); return this; } } };
    Object.defineProperty(patch, 'unref', bag.unref);`, 1],
  ["a descriptor map passed through a member", `const bag = { descriptors: { unref: { value() { clearInterval(this); return this; } } } };
    Object.defineProperties(patch, bag.descriptors);`, 1],
  ["a descriptor member that was replaced", `const bag = { unref: { value() { clearInterval(this); return this; } } };
    bag.unref = { enumerable: true, value() { clearInterval(this); return this; } };
    Object.defineProperty(patch, 'unref', bag.unref);`, 0],
]) {
  test(`timer patch copying respects ${name}`, async () => {
    const setup = `const probe = setInterval(() => {}, 100);
      clearInterval(probe);
      const prototype = Object.getPrototypeOf(probe);
      const patch = {};
      ${definition}
      Object.assign(prototype, patch);
      ${registration}.unref();`;
    assert.equal((await audit(producer + setup)).length, expected);
  });
}

test("repeated mutations reuse an immutable deep member path", async () => {
  const height = 90;
  const setup = `const jobs = [];
    function work(job) {}
    const tree = ${"{node:".repeat(height)}{}${"}".repeat(height)};
    const nested = tree${".node".repeat(height)};
    ${"Object.assign(nested, { label: 1 });\n".repeat(2_000)}
    setInterval(() => work(jobs.shift()), 100).unref();`;
  assert.deepEqual(await audit(setup), []);
});

for (const [name, definition, expected] of [
  ["enumeration changed by a local helper", `const descriptor = { value() { clearInterval(this); return this; } };
    function enable(value) { value.enumerable = true; }
    enable(descriptor);
    Object.defineProperty(patch, 'unref', descriptor);`, 0],
  ["an unrelated member of the descriptor owner changed", `const bag = { unref: { value() { clearInterval(this); return this; } } };
    bag.label = 1;
    Object.defineProperty(patch, 'unref', bag.unref);`, 1],
  ["an unrelated descriptor property changed", `const descriptor = { value() { clearInterval(this); return this; } };
    descriptor.writable = true;
    Object.defineProperty(patch, 'unref', descriptor);`, 1],
  ["an unrelated descriptor property changed by a local helper", `const descriptor = { value() { clearInterval(this); return this; } };
    function enable(value) { value.writable = true; }
    enable(descriptor);
    Object.defineProperty(patch, 'unref', descriptor);`, 1],
  ["enumeration changed by a forwarded helper argument", `const descriptor = { value() { clearInterval(this); return this; } };
    function setEnumeration(value) { value.enumerable = true; }
    function enable(value) { setEnumeration(value); }
    enable(descriptor);
    Object.defineProperty(patch, 'unref', descriptor);`, 0],
  ["enumeration changed through a helper parameter member", `const bag = { descriptor: { value() { clearInterval(this); return this; } } };
    function enable(value) { value.descriptor.enumerable = true; }
    enable(bag);
    Object.defineProperty(patch, 'unref', bag.descriptor);`, 0],
  ["enumeration changed through a forwarded helper parameter member", `const bag = { descriptor: { value() { clearInterval(this); return this; } } };
    function setEnumeration(value) { value.enumerable = true; }
    function enable(value) { setEnumeration(value.descriptor); }
    enable(bag);
    Object.defineProperty(patch, 'unref', bag.descriptor);`, 0],
  ["enumeration changed through a destructured helper parameter", `const descriptor = { value() { clearInterval(this); return this; } };
    function enable({ entry }) { entry.enumerable = true; }
    enable({ entry: descriptor });
    Object.defineProperty(patch, 'unref', descriptor);`, 0],
  ["enumeration changed through an object-literal helper method", `const descriptor = { value() { clearInterval(this); return this; } };
    const helpers = { enable(value) { value.enumerable = true; } };
    function prepare(value) { helpers.enable(value); }
    prepare(descriptor);
    Object.defineProperty(patch, 'unref', descriptor);`, 0],
  ["enumeration changed through a forwarded computed parameter key", `const entry = { value() { clearInterval(this); return this; } };
    const bag = { entry };
    function setEnumeration(value, key) { value[key].enumerable = true; }
    function enable(value, key) { setEnumeration(value, key); }
    enable(bag, 'entry');
    Object.defineProperty(patch, 'unref', entry);`, 0],
  ["a computed helper write to a different descriptor", `const entry = { value() { clearInterval(this); return this; } };
    const bag = { entry, other: {} };
    function enable(value, key) { value[key].enumerable = true; }
    enable(bag, 'other');
    Object.defineProperty(patch, 'unref', entry);`, 1],
  ["a descriptor changed after it was captured", `const descriptor = { value() { clearInterval(this); return this; } };
    Object.defineProperty(patch, 'unref', descriptor);
    descriptor.enumerable = true;`, 1],
  ["a descriptor-map entry changed after it was captured", `const descriptor = { value() { clearInterval(this); return this; } };
    const descriptors = { unref: descriptor };
    Object.defineProperties(patch, descriptors);
    function enable(value) { value.enumerable = true; }
    enable(descriptor);`, 1],
  ["repeated helper effects before and after descriptor capture", `const descriptor = { value() { clearInterval(this); return this; } };
    function enable(value) { value.enumerable = true; }
    enable(descriptor);
    Object.defineProperty(patch, 'unref', descriptor);
    enable(descriptor);`, 0],
  ["a later descriptor capture observes an intervening write", `const descriptor = { value() { clearInterval(this); return this; } };
    const descriptors = { unref: descriptor };
    Object.defineProperties({}, descriptors);
    descriptor.enumerable = true;
    Object.defineProperties(patch, descriptors);`, 0],
  ["an unrelated descriptor property copied directly", `const descriptor = { value() { clearInterval(this); return this; } };
    Object.assign(descriptor, { writable: true });
    Object.defineProperty(patch, 'unref', descriptor);`, 1],
  ["an unrelated descriptor property copied by a helper", `const descriptor = { value() { clearInterval(this); return this; } };
    function enable(value) { Object.assign(value, { writable: true }); }
    enable(descriptor);
    Object.defineProperty(patch, 'unref', descriptor);`, 1],
]) {
  test(`timer patch copying respects ${name}`, async () => {
    const setup = `const probe = setInterval(() => {}, 100);
      clearInterval(probe);
      const prototype = Object.getPrototypeOf(probe);
      const patch = {};
      ${definition}
      Object.assign(prototype, patch);
      ${registration}.unref();`;
    assert.equal((await audit(producer + setup)).length, expected);
  });
}

test("repeated mutations reuse a destructured deep member path", async () => {
  const height = 90;
  const setup = `const jobs = [];
    function work(job) {}
    const tree = ${"{node:".repeat(height)}{nested:{}}${"}".repeat(height)};
    const {nested} = tree${".node".repeat(height)};
    ${"Object.assign(nested, { label: 1 });\n".repeat(2_000)}
    setInterval(() => work(jobs.shift()), 100).unref();`;
  assert.deepEqual(await audit(setup), []);
});

test("repeated helper calls reuse harmless writes to the same object", async () => {
  const writes = Array.from({ length: 250 }, (_, index) => `value.property${index} = 1;`).join("\n");
  const setup = `const jobs = [];
    function work(job) {}
    const descriptor = {};
    function annotate(value) { ${writes} }
    ${"annotate(descriptor);\n".repeat(1_000)}
    setInterval(() => work(jobs.shift()), 100).unref();`;
  assert.deepEqual(await audit(setup), []);
});

test("repeated mixed helper writes reuse benign effects and retain unref writes", async () => {
  const writes = Array.from({ length: 250 }, (_, index) => `value.property${index} = 1;`).join("\n");
  const setup = `const probe = setInterval(() => {}, 100);
    clearInterval(probe);
    const prototype = Object.getPrototypeOf(probe);
    const patch = {};
    function annotate(value) { value.unref = function () { clearInterval(this); return this; }; ${writes} }
    ${"annotate(patch);\n".repeat(1_000)}
    Object.assign(prototype, patch);
    ${registration}.unref();`;
  assert.deepEqual(await audit(producer + setup), []);
});

const descriptorSetup = `
  const probe = setInterval(() => {}, 100);
  clearInterval(probe);
  const prototype = Object.getPrototypeOf(probe);
  const patch = {};
  function cancel() { clearInterval(this); return this; }
`;
const descriptorCopy = `Object.assign(prototype, patch); ${registration}.unref();`;
const enumerableUnref = "{ configurable: true, enumerable: true, value: cancel }";

for (const [name, first, last, expected] of [
  ["hidden last", enumerableUnref, "{ value: cancel }", 1],
  ["enumerable last", "{ value: cancel }", enumerableUnref, 0],
]) {
  test(`the final duplicate descriptor map entry wins with ${name}`, async () => {
    const setup = `Object.defineProperties(patch, { unref: ${first}, ["unref"]: ${last} });`;
    assert.equal((await audit(producer + descriptorSetup + setup + descriptorCopy)).length, expected);
  });
}

for (const [name, redefinition, expected] of [
  ["explicitly hidden", 'Object.defineProperty(patch, "unref", { enumerable: false });', 1],
  ["hidden through descriptor map", 'Object.defineProperties(patch, { unref: { enumerable: false } });', 1],
  ["omitted flag preserves enumerability", 'Object.defineProperty(patch, "unref", { value: cancel });', 0],
  ["re-enabled", `Object.defineProperty(patch, "unref", { enumerable: false });
    Object.defineProperty(patch, "unref", { enumerable: true });`, 0],
  ["conditional hide", 'if (enabled) Object.defineProperty(patch, "unref", { enumerable: false });', 0],
]) {
  test(`repeated unref definitions respect ${name} before copying`, async () => {
    const setup = `Object.defineProperty(patch, "unref", ${enumerableUnref}); ${redefinition}`;
    assert.equal((await audit(producer + descriptorSetup + setup + descriptorCopy)).length, expected);
  });
}

for (const invocation of [
  "expose.call(null, flags)",
  'expose["apply"](null, [flags])',
  "forward(flags)",
]) {
  test(`descriptor writes flow through ${invocation}`, async () => {
    const setup = `const flags = { value: cancel };
      function expose(value) { value.enumerable = true; }
      function forward(value) { expose.apply(null, [value]); }
      ${invocation};
      Object.defineProperty(patch, "unref", flags);`;
    assert.deepEqual(await audit(producer + descriptorSetup + setup + descriptorCopy), []);
  });
}

for (const [name, before, between, after, expected] of [
  ["before both groups", "flags.enumerable = true;", "", "", 0],
  ["between groups", "", "flags.enumerable = true;", "", 0],
  ["after both groups", "", "", "flags.enumerable = true;", 1],
  ["conditionally between groups", "", "if (enabled) flags.enumerable = true;", "", 0],
]) {
  test(`repeated wide descriptor maps respect a flag mutation ${name}`, async () => {
    const fields = Array.from({ length: 250 }, (_, index) => `property${index}: { value: 1 }`).join(",");
    const installs = "Object.defineProperties(patch, descriptions);\n".repeat(500);
    const setup = `const flags = { value: cancel, configurable: true };
      const descriptions = { unref: flags, ${fields} };
      ${before}
      ${installs}
      ${between}
      ${installs}
      ${after}`;
    assert.equal((await audit(producer + descriptorSetup + setup + descriptorCopy)).length, expected);
  });
}

test("an imported descriptor does not prove that unref is hidden", async () => {
  const setup = `import { flags } from "./flags.js";
    const descriptions = { unref: flags };
    Object.defineProperties(patch, descriptions);`;
  const files = {
    "flags.js": `export const flags = { value() { clearInterval(this); return this; } };
      flags.enumerable = true;`,
  };
  assert.deepEqual(await audit(producer + descriptorSetup + setup + descriptorCopy, files), []);
});
