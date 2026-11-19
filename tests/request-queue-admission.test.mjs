import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";

const http = "import { createServer } from 'node:http';";
const queue = `
const jobs = ([] as string[]) satisfies string[];
let outstanding = 0;
function enqueue(job: string) { jobs.push(job); outstanding++; }
function work(job: string | undefined) { if (job !== undefined) outstanding--; }
setInterval(() => work(jobs.shift()), 100);
`;
const guard = "if (outstanding >= 10) return;";

async function audit(files) {
  const root = await mkdtemp(join(tmpdir(), "scale-admission-"));
  try {
    for (const [name, source] of Object.entries(files)) await writeFile(join(root, name), source);
    return await detectQueueBackpressure(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const identity of ["enqueue", "enqueue.bind(null)"]) {
  test(`a guarded call through ${identity} preserves bounded queue admission`, async () => {
    const source = `${http}${queue}
    const submit = ${identity};
    createServer(req => { ${guard} submit(req.url ?? 'job'); });`;
    assert.deepEqual(await audit({ "server.ts": source }), []);
  });
}

test("a guarded bound alias imported across files preserves admission", async () => {
  const findings = await audit({
    "queue.ts": `${queue}\nexport { enqueue, outstanding };`,
    "server.ts": `${http}
      import { enqueue as pushJob, outstanding } from './queue.js';
      const submit = pushJob.bind(null);
      createServer(req => { ${guard} submit(req.url ?? 'job'); });`,
  });
  assert.deepEqual(findings, []);
});

test("a replaced call method is not an additional enqueue path", async () => {
  const source = `${http}${queue}
    enqueue.call = () => {};
    createServer(req => { ${guard} enqueue(req.url ?? 'job'); });
    createServer(req => enqueue.call(null, req.url ?? 'job'));`;
  assert.deepEqual(await audit({ "server.ts": source }), []);
});

test("a real unguarded bound call is retained beside guarded direct calls", async () => {
  const source = `${http}${queue}
    const submit = enqueue.bind(null);
    createServer(req => { ${guard} enqueue(req.url ?? 'job'); });
    createServer(req => submit(req.url ?? 'job'));`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

test("a registered producer is retained beside guarded direct calls", async () => {
  const source = `${http}${queue}
    createServer(enqueue);
    createServer(req => { ${guard} enqueue(req.url ?? 'job'); });`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

for (const enqueue of ["enqueue", "jobs.push"]) {
  for (const statement of [`void ${enqueue}('job');`, `const result = ${enqueue}('job');`]) {
    test(`request enqueue is recognized in ${statement}`, async () => {
      const source = `${http}${queue} createServer(() => { ${statement} });`;
      assert.equal((await audit({ "server.ts": source })).length, 1);
    });
  }
}

for (const dispatch of [
  "[job].forEach(enqueue)",
  "Array.from([job], enqueue)",
  "[job].reduce(enqueue, job)",
  "new Promise(enqueue)",
]) {
  test(`capacity guard covers native callback in ${dispatch}`, async () => {
    const source = `${http}${queue}
      createServer(() => { ${guard} const job = 'job'; ${dispatch}; });`;
    assert.deepEqual(await audit({ "server.ts": source }), []);
  });

  test(`unguarded native callback in ${dispatch} stays visible beside a guarded direct call`, async () => {
    const source = `${http}${queue}
      createServer(() => { ${guard} enqueue('guarded'); });
      createServer(() => { const job = 'job'; ${dispatch}; });`;
    assert.equal((await audit({ "server.ts": source })).length, 1);
  });
}

test("settled Promise callbacks still run after a guard at registration", async () => {
  const source = `${http}${queue}
    createServer(() => { ${guard} Promise.resolve('job').then(enqueue); });`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

test("an unguarded settled Promise callback stays visible beside a guarded direct call", async () => {
  const source = `${http}${queue}
    createServer(() => { ${guard} enqueue('guarded'); });
    createServer(() => { Promise.resolve('job').then(enqueue); });`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

for (const dispatch of ["[].forEach(enqueue)", "unknown(enqueue)"]) {
  test(`${dispatch} supplies no proven unguarded caller`, async () => {
    const source = `${http}${queue}
      createServer(() => { ${guard} enqueue('guarded'); });
      createServer(() => { ${dispatch}; });`;
    assert.deepEqual(await audit({ "server.ts": source }), []);
  });
}

for (const enqueue of ["enqueue", "jobs.push"]) {
  for (const statement of [`await ${enqueue}('job');`, `const result = await ${enqueue}('job');`]) {
    test(`request enqueue is recognized in ${statement}`, async () => {
      const source = `${http}${queue} createServer(async () => { ${statement} });`;
      assert.equal((await audit({ "server.ts": source })).length, 1);
    });
  }

  test(`awaited ${enqueue} requires a counter updated before suspension`, async () => {
    const source = `${http}${queue} createServer(async () => { ${guard} await ${enqueue}('job'); });`;
    assert.equal((await audit({ "server.ts": source })).length, enqueue === "jobs.push" ? 1 : 0);
  });
}

for (const dispatch of [
  "[job, job].forEach(value => enqueue(value))",
  "Array.from([job, job], value => enqueue(value))",
  "Array.from({ length: 2 }, value => enqueue(value))",
  "Array.from({ length: 2 }).forEach(enqueue)",
]) {
  test(`capacity guard reaches the enqueue wrapper in ${dispatch}`, async () => {
    const source = `${http}${queue}
      createServer(() => { ${guard} const job = 'job'; ${dispatch}; });`;
    assert.deepEqual(await audit({ "server.ts": source }), []);
  });
}

for (const dispatch of [
  "Array.from({ length: Number(req.url?.slice(1)) }, enqueue)",
  "Array.from({ length: Number(req.url?.slice(1)) }, job => enqueue(job))",
  "Array.from({ length: Number(req.url?.slice(1)) }).forEach(enqueue)",
]) {
  test(`one capacity check cannot bound the request-sized batch in ${dispatch}`, async () => {
    const source = `${http}${queue}
      createServer(req => { ${guard} ${dispatch}; });`;
    assert.equal((await audit({ "server.ts": source })).length, 1);
  });
}

test("an admission guard inside an unknown-size callback covers every item", async () => {
  const source = `${http}${queue}
    createServer(req => Array.from({ length: Number(req.url?.slice(1)) }, job => {
      ${guard} enqueue(job);
    }));`;
  assert.deepEqual(await audit({ "server.ts": source }), []);
});

test("an unguarded wrapper is retained beside a guarded callback wrapper", async () => {
  const source = `${http}${queue}
    const submit = job => enqueue(job);
    createServer(() => { ${guard} ['job'].forEach(submit); });
    createServer(() => ['job'].forEach(submit));`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

for (const enqueue of ["enqueue", "jobs.push"]) {
  for (const statement of [
    `let result; result = await ${enqueue}('job');`,
    `console.log(await ${enqueue}('job'));`,
  ]) {
    test(`awaited enqueue remains visible in ${statement}`, async () => {
      const source = `${http}${queue} createServer(async () => { ${statement} });`;
      assert.equal((await audit({ "server.ts": source })).length, 1);
      const guarded = `${http}${queue} createServer(async () => { ${guard} ${statement} });`;
      assert.equal((await audit({ "server.ts": guarded })).length, enqueue === "jobs.push" ? 1 : 0);
    });
  }
}

for (const dispatch of [
  "await pending; enqueue('job');",
  "enqueue(await pending);",
  "consume(await pending, enqueue('job'));",
  "for await (const job of jobsToRead) {} enqueue('job');",
  "if (req.url) { try { await pending; throw new Error('retry'); } catch {} } enqueue('job');",
  "const job = await pending; jobs.push(job);",
  "const job = await pending; ['job'].forEach(enqueue);",
]) {
  test(`a capacity check can go stale before ${dispatch}`, async () => {
    const source = `${http}${queue}
      const pending = new Promise<string>(resolve => setTimeout(() => resolve('job'), 100));
      createServer(async () => { ${guard} ${dispatch} });`;
    assert.equal((await audit({ "server.ts": source })).length, 1);
  });
}

for (const dispatch of [
  "consume(enqueue('job'), await pending);",
  "1 ?? await pending; enqueue('job');",
  "null?.foo(await pending); enqueue('job');",
  "null?.foo[await pending].bar(); enqueue('job');",
  "if (req.url === '/skip') { await pending; return; } enqueue('job');",
  "if (req.url === '/skip') { await pending; throw new Error('skip'); } enqueue('job');",
]) {
  test(`admission holds when suspension cannot precede enqueue in ${dispatch}`, async () => {
    const source = `${http}${queue}
      const pending = new Promise<string>(resolve => setTimeout(() => resolve('job'), 100));
      createServer(async req => { ${guard} ${dispatch} });`;
    assert.deepEqual(await audit({ "server.ts": source }), []);
  });
}

test("checking admission again after awaiting the job covers the enqueue", async () => {
  const source = `${http}${queue}
    createServer(async () => { ${guard} const job = await load(); ${guard} enqueue(job); });`;
  assert.deepEqual(await audit({ "server.ts": source }), []);
});

test("an awaiting enqueue helper invalidates the guard in its caller", async () => {
  const source = `${http}${queue}
    async function submit() { const job = await load(); jobs.push(job); }
    createServer(async () => { ${guard} await submit(); });`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

for (const dispatch of [
  "Array.from({ length: count }, (_, i) => enqueue(String(i)))",
  "Array.from({ length: count }).forEach((_, i) => enqueue(String(i)))",
]) {
  test(`a remaining-capacity size check covers ${dispatch}`, async () => {
    const source = `${http}${queue}
      createServer(req => {
        const count = Number(req.url?.slice(1));
        if (!Number.isSafeInteger(count) || count < 0 || count > 10 - outstanding) return;
        ${dispatch};
      });`;
    assert.deepEqual(await audit({ "server.ts": source }), []);
  });
}

for (const remaining of ["10", "10 - outstanding"]) {
  test(`native Math.min caps a batch at ${remaining}`, async () => {
    const source = `${http}${queue}
      createServer(req => {
        ${remaining === "10" ? guard : ""}
        const count = Math.min(${remaining}, Number(req.url?.slice(1)));
        Array.from({ length: count }, (_, i) => enqueue(String(i)));
      });`;
    assert.deepEqual(await audit({ "server.ts": source }), []);
  });
}

test("a shadowed Math.min cannot prove batch cardinality", async () => {
  const source = `${http}${queue}
    const Math = { min: (_, size) => size };
    createServer(req => {
      ${guard}
      const count = Math.min(10, Number(req.url?.slice(1)));
      Array.from({ length: count }, (_, i) => enqueue(String(i)));
    });`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

test("a batch length comparison must use the actual immutable count", async () => {
  const source = `${http}${queue}
    createServer(req => {
      const count = Number(req.url?.slice(1));
      if (count > 10 - outstanding) return;
      Array.from({ length: count * 1000 }, (_, i) => enqueue(String(i)));
    });`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

test("a remaining-capacity clamp calculated before suspension can go stale", async () => {
  const source = `${http}${queue}
    createServer(async req => {
      const count = Math.min(10 - outstanding, Number(req.url?.slice(1)));
      await load();
      Array.from({ length: count }, (_, i) => enqueue(String(i)));
    });`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

for (const beforeEnqueue of [
  "if (req.url) await load();",
  "const job = await load(); if (!job) return;",
]) {
  test(`a stale capacity check stays stale after ${beforeEnqueue}`, async () => {
    const source = `${http}${queue} createServer(async req => {
      ${guard}
      ${beforeEnqueue}
      enqueue(req.url ?? 'job');
    });`;
    assert.equal((await audit({ "server.ts": source })).length, 1);
  });
}

test("a deferred native promise callback cannot inherit capacity admission", async () => {
  const source = `${http}${queue}
    const pending = new Promise<string>(resolve => setTimeout(() => resolve('job'), 100));
    createServer(() => { ${guard} pending.then(enqueue); });`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

test("a deferred callback can check capacity when it runs", async () => {
  const source = `${http}${queue}
    const pending = new Promise<string>(resolve => setTimeout(() => resolve('job'), 100));
    createServer(() => { pending.then(job => { ${guard} enqueue(job); }); });`;
  assert.deepEqual(await audit({ "server.ts": source }), []);
});

for (const skipped of ["false && await load();", "true || await load();", "if (false) await load();"]) {
  test(`a skipped suspension preserves queue admission after ${skipped}`, async () => {
    const source = `${http}${queue}
      createServer(async () => { ${guard} ${skipped} enqueue('job'); });`;
    assert.deepEqual(await audit({ "server.ts": source }), []);
  });
}

test("an unrelated mutable binding cannot serve as a remaining-capacity clamp", async () => {
  const source = `${http}${queue}
    let unrelated = 0;
    createServer(req => {
      const count = Math.min(10 - unrelated, Number(req.url?.slice(1)));
      Array.from({ length: count }, (_, i) => enqueue(String(i)));
    });`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

test("an unrelated mutable binding cannot serve as a remaining-capacity comparison", async () => {
  const source = `${http}${queue}
    let unrelated = 0;
    createServer(req => {
      const count = Number(req.url?.slice(1));
      if (count > 10 - unrelated) return;
      Array.from({ length: count }, (_, i) => enqueue(String(i)));
    });`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

for (const mutation of ["Math.min = (_, size) => size;", "const math = Math; math.min = (_, size) => size;"]) {
  test(`a visible native Math.min replacement cannot prove a bound via ${mutation}`, async () => {
    const source = `${http}${queue}
      ${mutation}
      createServer(req => {
        ${guard}
        const count = Math.min(10, Number(req.url?.slice(1)));
        Array.from({ length: count }, (_, i) => enqueue(String(i)));
      });`;
    assert.equal((await audit({ "server.ts": source })).length, 1);
  });
}

for (const statement of [
  "if (req.url) { await pending; enqueue(req.url); }",
  "{ await pending; enqueue(req.url); }",
  "let result; result = enqueue(await pending);",
]) {
  test(`nested or assigned enqueue uses the actual suspension before ${statement}`, async () => {
    const source = `${http}${queue}
      const pending = new Promise<string>(resolve => setTimeout(() => resolve('job'), 100));
      createServer(async req => { ${guard} ${statement} });`;
    assert.equal((await audit({ "server.ts": source })).length, 1);
  });
}

test("an unconditional nested plain block preserves open admission", async () => {
  const source = `${http}${queue}
    createServer(req => { { enqueue(req.url); } });`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

test("nested enqueues retain a refreshed queue capacity guard", async () => {
  const source = `${http}${queue}
    createServer(async req => { await load(); ${guard} { enqueue(req.url); } });`;
  assert.deepEqual(await audit({ "server.ts": source }), []);
});

test("sibling branch capacity checks cannot guard a resumed enqueue", async () => {
  const source = `${http}${queue}
    createServer(async req => {
      await load();
      if (req.url) { ${guard} } else { enqueue(req.url); }
    });`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

for (const prefix of [
  "while (false) await pending;",
  "for (; false;) await pending;",
  "while (req.url) { await pending; return; }",
  "try { if (req.url) { await pending; return; } } finally {}",
]) {
  test(`skipped or exiting suspension preserves admission after ${prefix}`, async () => {
    const source = `${http}${queue}
      const pending = new Promise<string>(resolve => setTimeout(() => resolve('job'), 100));
      createServer(async req => { ${guard} ${prefix} enqueue(req.url); });`;
    assert.deepEqual(await audit({ "server.ts": source }), []);
  });
}

test("a loop initializer can suspend even when its body is skipped", async () => {
  const source = `${http}${queue}
    createServer(async req => { ${guard} for (await load(); false;) {} enqueue(req.url); });`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

test("a loop body that suspends and breaks can reach the enqueue", async () => {
  const source = `${http}${queue}
    createServer(async req => { ${guard} while (req.url) { await load(); break; } enqueue(req.url); });`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

for (const statement of [
  "try { await pending; enqueue(req.url); } finally {}",
  "for (let i = 0; i < 2; i++) { await pending; enqueue(req.url); }",
  "switch (req.url) { case '/': await pending; enqueue(req.url); break; }",
]) {
  test(`nested control retains suspension before ${statement}`, async () => {
    const source = `${http}${queue}
      const pending = new Promise<string>(resolve => setTimeout(() => resolve('job'), 100));
      createServer(async req => { ${guard} ${statement} });`;
    assert.equal((await audit({ "server.ts": source })).length, 1);
  });
}

test("a renewed guard inside a try block protects its enqueue", async () => {
  const source = `${http}${queue}
    createServer(async req => { try { await load(); ${guard} enqueue(req.url); } finally {} });`;
  assert.deepEqual(await audit({ "server.ts": source }), []);
});

for (const exit of ["return;", "throw 0;"]) {
  test(`a suspended break still reaches the enqueue before an alternative ${exit}`, async () => {
    const source = `${http}${queue}
      createServer(async req => {
        ${guard}
        while (req.url) { await load(); if (req.url === '/') break; ${exit} }
        enqueue(req.url);
      });`;
    assert.equal((await audit({ "server.ts": source })).length, 1);
  });
}

for (const prefix of [
  "while (req.url) { break; await load(); }",
  "for (; req.url; await load()) { break; }",
  "while (req.url) { if (req.url === '/') break; await load(); return; }",
]) {
  test(`a skipped or terminating await preserves admission after ${prefix}`, async () => {
    const source = `${http}${queue}
      createServer(async req => { ${guard} ${prefix} enqueue(req.url); });`;
    assert.deepEqual(await audit({ "server.ts": source }), []);
  });
}

for (const statement of [
  "for (let i = 0; i < 2; i++) { if (i === 0) { await load(); continue; } enqueue(req.url); }",
  "for (let i = 0; i < 2; await load(), i++) enqueue(req.url);",
  "do { enqueue(req.url); await load(); } while (req.url);",
  "switch (req.url) { case '/first': await load(); case '/second': enqueue(req.url); }",
]) {
  test(`suspension across iterations or case fallthrough reaches ${statement}`, async () => {
    const source = `${http}${queue} createServer(async req => { ${guard} ${statement} });`;
    assert.equal((await audit({ "server.ts": source })).length, 1);
  });
}

for (const statement of [
  "do { enqueue(req.url); await load(); } while (false);",
  "for (let i = 0; i < 2; await load(), i++) { enqueue(req.url); break; }",
  "for (let i = 0; i < 2; i++) { if (req.url === '/') { await load(); break; } enqueue(req.url); }",
  "for (let i = 0; i < 2; i++) { if (i === 0) { await load(); continue; } if (outstanding >= 10) return; enqueue(req.url); }",
  "switch (req.url) { case '/first': await load(); break; case '/second': enqueue(req.url); }",
  "switch (req.url) { case '/first': await load(); return; case '/second': enqueue(req.url); }",
]) {
  test(`enqueues retain valid admission when ${statement}`, async () => {
    const source = `${http}${queue} createServer(async req => { ${guard} ${statement} });`;
    assert.deepEqual(await audit({ "server.ts": source }), []);
  });
}

for (const statement of [
  "switch (req.url) { case await pending: break; case '/': enqueue(req.url); }",
  "switch (req.url) { default: enqueue(req.url); break; case await pending: break; }",
  "switch (req.url) { default: if (outstanding >= 10) return; enqueue(req.url); break; case await pending: break; }",
]) {
  const rechecks = statement.includes("if (outstanding");
  test(`switch search accounts for test suspension before ${statement}`, async () => {
    const source = `${http}${queue} const pending = Promise.resolve('job');
      createServer(async req => { ${guard} ${statement} });`;
    assert.equal((await audit({ "server.ts": source })).length, rechecks ? 0 : 1);
  });
}

test("fallthrough into a later switch clause skips its awaited test after a known match", async () => {
  const source = `${http}${queue} const pending = Promise.resolve(1);
    createServer(async req => {
      ${guard}
      switch (0) { case 0: console.log(0); case await pending: enqueue(req.url); }
    });`;
  assert.deepEqual(await audit({ "server.ts": source }), []);
});

for (const statement of [
  "for (let i = 0; i < 1; i++) { enqueue(req.url); await pending; }",
  "for (let i = 0; i < 1; i++) { enqueue(String(i)); await pending; }",
  "for (const item of [1]) { enqueue(req.url); await pending; }",
]) {
  test(`an await after enqueue cannot affect a nonexistent second iteration in ${statement}`, async () => {
    const source = `${http}${queue} const pending = Promise.resolve('job');
      createServer(async req => { ${guard} ${statement} });`;
    assert.deepEqual(await audit({ "server.ts": source }), []);
  });
}

for (const statement of [
  "for (let i = 0; i < 1; i++) { enqueue(req.url); await pending; i--; }",
  "for (let i = 0; i < 1; i++) { enqueue(req.url); await pending; [i] = [-1]; }",
  "for await (const item of [1]) { enqueue(req.url); }",
]) {
  test(`possible suspension still invalidates capacity in ${statement}`, async () => {
    const source = `${http}${queue} const pending = Promise.resolve('job');
      createServer(async req => { ${guard} ${statement} });`;
    assert.equal((await audit({ "server.ts": source })).length, 1);
  });
}

test("a fallthrough-only switch entry inherits admission from the preceding case", async () => {
  const source = `${http}${queue}
    createServer(req => {
      switch ('/first') { case '/first': ${guard} case '/second': enqueue(req.url); }
    });`;
  assert.deepEqual(await audit({ "server.ts": source }), []);
});

test("a directly selectable case can bypass the preceding case's guard", async () => {
  const source = `${http}${queue}
    createServer(req => {
      switch (req.url) { case '/first': ${guard} case '/second': enqueue(req.url); }
    });`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

test("an await after a switch case's capacity check can still make fallthrough stale", async () => {
  const source = `${http}${queue}
    createServer(async req => {
      switch ('/first') { case '/first': ${guard} await load(); case '/second': enqueue(req.url); }
    });`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

for (const statement of [
  "outer: for (let i = 0; i < 2; i++) { if (i === 0) { await load(); continue outer; } enqueue(req.url); }",
  "label: { await load(); enqueue(req.url); }",
]) {
  test(`labeled suspension reaches enqueue in ${statement}`, async () => {
    const source = `${http}${queue} createServer(async req => { ${guard} ${statement} });`;
    assert.equal((await audit({ "server.ts": source })).length, 1);
  });
}

test("continuing a different labeled loop does not resume the inner loop", async () => {
  const source = `${http}${queue} createServer(async req => {
    outer: for (let i = 0; i < 2; i++) {
      ${guard}
      for (let j = 0; j < 2; j++) {
        enqueue(req.url);
        if (req.url) { await load(); continue outer; }
      }
    }
  });`;
  assert.deepEqual(await audit({ "server.ts": source }), []);
});

for (const statement of [
  "for (let i = 0; i <= 0; i++) { enqueue(String(i)); await load(); }",
  "for (let i = -1; i < 0; i++) { enqueue(String(i)); await load(); }",
]) {
  test(`enqueue stays guarded in singleton ${statement}`, async () => {
    const source = `${http}${queue} createServer(async req => { ${guard} ${statement} });`;
    assert.deepEqual(await audit({ "server.ts": source }), []);
  });
}

test("nested singleton loops share write analysis for an entirely read-only body", async () => {
  const body = "for(let i=0;i<1;i++){".repeat(35) + "void req.url;\n".repeat(3000)
    + "enqueue(req.url); await load();" + "}".repeat(35);
  const source = `${http}${queue} createServer(async req => { ${guard} ${body} });`;
  assert.deepEqual(await audit({ "server.ts": source }), []);
});

test("labeled continues reuse their target through deeply nested blocks", async () => {
  const body = "{".repeat(100) + "if(req.url)continue outer;\n".repeat(1000)
    + "await load(); enqueue(req.url);" + "}".repeat(100);
  const source = `${http}${queue} createServer(async req => { ${guard} outer:while(req.url){ ${body} } });`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

for (const statement of [
  "if(req.url) { label: { await load(); return; } }",
  "while(req.url) { label: { await load(); return; } }",
]) {
  test(`an await on a labeled path that returns preserves later admission in ${statement}`, async () => {
    const source = `${http}${queue} createServer(async req => { ${guard} ${statement} enqueue(req.url); });`;
    assert.deepEqual(await audit({ "server.ts": source }), []);
  });
}

test("an await before a break to a labeled block still reaches the following enqueue", async () => {
  const source = `${http}${queue} createServer(async req => {
    ${guard}
    label: { if(req.url) { await load(); break label; } }
    enqueue(req.url);
  });`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

test("nested repeated loops reuse flow-relevant statements in a read-only body", async () => {
  const body = "for(let i=0;i<2;i++){".repeat(20) + "void req.url;\n".repeat(3000)
    + "enqueue(req.url); await load();" + "}".repeat(20);
  const source = `${http}${queue} createServer(async req => { ${guard} ${body} });`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

for (const [target, expected] of [["outer", 0], ["inner", 1]]) {
  test(`an awaited break to ${target} keeps its actual target through another label`, async () => {
    const source = `${http}${queue} createServer(async req => {
      ${guard}
      outer: {
        if(req.url) { inner: { await load(); break ${target}; } }
        enqueue(req.url);
      }
    });`;
    assert.equal((await audit({ "server.ts": source })).length, expected);
  });
}

test("a switch break and a break to an outer label have different admission timing", async () => {
  for (const [target, expected] of [["outer", 0], ["", 1]]) {
    const source = `${http}${queue} createServer(async req => {
      ${guard}
      outer: {
        switch(req.url) { case "/a": await load(); break ${target}; default: break; }
        enqueue(req.url);
      }
    });`;
    assert.equal((await audit({ "server.ts": source })).length, expected);
  }
});

test("nested repeated loops omit read-only branches from their shared flow projection", async () => {
  const body = "for(let i=0;i<2;i++){".repeat(10) + "if(req.url)void 0;\n".repeat(3000)
    + "enqueue(req.url); await load();" + "}".repeat(10);
  const source = `${http}${queue} createServer(async req => { ${guard} ${body} });`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

test("nested repeated loops omit definitely skipped awaits from their shared flow projection", async () => {
  const body = "for(let i=0;i<2;i++){".repeat(10) + "if(false)await load();\n".repeat(3000)
    + "enqueue(req.url); await load();" + "}".repeat(10);
  const source = `${http}${queue} createServer(async req => { ${guard} ${body} });`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

for (const shell of ["try { void req.url; } finally {}", "local: { void req.url; }", "switch(req.url) { default: break; }"]) {
  test(`nested repeated loops share the projection of inert ${shell}`, async () => {
    const body = "for(let i=0;i<2;i++){".repeat(10) + (shell + "\n").repeat(3000)
      + "enqueue(req.url); await load();" + "}".repeat(10);
    const source = `${http}${queue} createServer(async req => { ${guard} ${body} });`;
    assert.equal((await audit({ "server.ts": source })).length, 1);
  });
}

for (const [statement, expected] of [
  ["try { await load(); break outside; } catch { break outside; } finally { void 0; }", 0],
  ["try { await load(); } finally { break outside; }", 0],
  ["try { await load(); break outside; } finally { break; }", 1],
  ["try { break outside; } finally { await load(); }", 0],
]) {
  test(`finally respects the target of ${statement}`, async () => {
    const source = `${http}${queue} createServer(async req => {
      ${guard}
      outside: {
        while (req.url) { ${statement} }
        enqueue(req.url);
      }
    });`;
    assert.equal((await audit({ "server.ts": source })).length, expected);
  });
}

for (const [caught, expected] of [["break outside;", 0], ["break;", 1]]) {
  test(`try and catch preserve distinct completion targets with ${caught}`, async () => {
    const source = `${http}${queue} createServer(async req => {
      ${guard}
      outside: {
        while (req.url) {
          try { await load(); break outside; } catch { ${caught} }
        }
        enqueue(req.url);
      }
    });`;
    assert.equal((await audit({ "server.ts": source })).length, expected);
  });
}

test("a try that returns or catches and breaks cannot suspend into another enqueue", async () => {
  const source = `${http}${queue} createServer(async req => {
    ${guard}
    for (let i = 0; i < 2; i++) {
      enqueue(req.url);
      try { await load(); return; } catch { break; }
    }
  });`;
  assert.deepEqual(await audit({ "server.ts": source }), []);
});

for (const loop of [
  "do { if(req.url) { await load(); break outer; } } while(false);",
  "for (const job of [1]) { if(req.url) { await load(); break outer; } }",
]) {
  test(`an awaited break from ${loop} skips the enqueue inside its target label`, async () => {
    const source = `${http}${queue} createServer(async req => {
      ${guard}
      outer: {
        ${loop}
        enqueue(req.url);
      }
    });`;
    assert.deepEqual(await audit({ "server.ts": source }), []);
  });
  test(`an awaited local break from ${loop} reaches the enqueue`, async () => {
    const source = `${http}${queue} createServer(async req => {
      ${guard}
      outer: {
        ${loop.replace("break outer;", "break;")}
        enqueue(req.url);
      }
    });`;
    assert.equal((await audit({ "server.ts": source })).length, 1);
  });
}

test("nested repeated loops omit branches whose right operand cannot suspend", async () => {
  const body = "for(let i=0;i<2;i++){".repeat(10) + "if(req.url){false && await load();}\n".repeat(3000)
    + "enqueue(req.url); await load();" + "}".repeat(10);
  const source = `${http}${queue} createServer(async req => { ${guard} ${body} });`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

for (const statement of [
  "switch(0) { case 0: break; case 1: await load(); break; }",
  "switch(0) { case 0: break; case await load(): break; }",
  "switch(0) { default: await load(); break; case 0: break; }",
  "switch(-1) { case -1: break; case await load(): break; }",
  "switch(+1) { case 1: break; case await load(): break; }",
  "switch(1n) { case 1n: break; case await load(): break; }",
  "switch(-1_000n) { case -1000n: break; case await load(): break; }",
]) {
  test(`a literal switch preserves admission across skipped suspension in ${statement}`, async () => {
    const source = `${http}${queue} createServer(async req => {
      ${guard}
      ${statement}
      enqueue(req.url);
    });`;
    assert.deepEqual(await audit({ "server.ts": source }), []);
  });
}

test("a reachable fallthrough still invalidates admission after suspension", async () => {
  const source = `${http}${queue} createServer(async req => {
    ${guard}
    switch(0) { case 0: void req.url; case 1: await load(); break; }
    enqueue(req.url);
  });`;
  assert.equal((await audit({ "server.ts": source })).length, 1);
});

for (const terminal of [
  "switch(0) { case 0: return; }",
  "switch(req.url) { default: return; }",
  "while(true) { return; }",
  "while(true) {}",
  "do { return; } while(false);",
  "for (;;) { return; }",
]) {
  test(`suspension after terminal ${terminal} cannot stale admission`, async () => {
    const source = `${http}${queue} createServer(async req => {
      ${guard}
      if (req.url) { ${terminal} await load(); }
      enqueue(req.url);
    });`;
    assert.deepEqual(await audit({ "server.ts": source }), []);
  });
}

for (const continuing of [
  "switch(req.url) { case '/': return; }",
  "switch(0) { case 0: break; default: return; }",
  "while(true) { break; }",
  "exit: while(true) { break exit; }",
  "next: do { continue next; } while(false);",
  "while(req.url) { return; }",
  "try { while(true) { await load(); } } catch {}",
]) {
  test(`suspension after continuing ${continuing} invalidates admission`, async () => {
    const source = `${http}${queue} createServer(async req => {
      ${guard}
      if (req.url) { ${continuing} await load(); }
      enqueue(req.url);
    });`;
    assert.equal((await audit({ "server.ts": source })).length, 1);
  });
}

for (const declaration of ["{ value = await load() } of [{}]", "[value = await load()] of [[]]"]) {
  test(`loop binding default suspends before enqueue: ${declaration}`, async () => {
    const source = `${http}${queue} createServer(async req => {
      ${guard}
      for (const ${declaration}) { enqueue(req.url); }
    });`;
    assert.equal((await audit({ "server.ts": source })).length, 1);
  });
}

for (const inert of [
  "switch(0) { case 0: break; case await load(): break; }",
  "if(req.url) { false ? await load() : void 0; }",
  "while(false) { await load(); }",
]) {
  test(`nested loop analysis shares the flow projection of ${inert}`, async () => {
    const body = "for(let i=0;i<2;i++){".repeat(10) + (inert + "\n").repeat(3000)
      + "enqueue(req.url); await load();" + "}".repeat(10);
    const source = `${http}${queue} createServer(async req => { ${guard} ${body} });`;
    assert.equal((await audit({ "server.ts": source })).length, 1);
  });
}

for (const statement of [
  "try { void req.url; } finally {}",
  "label: { void req.url; }",
  "switch(req.url) { default: break; }",
  "if(req.url) console.log(req.url);",
]) {
  test(`a harmless prefix does not establish admission in ${statement}`, async () => {
    const source = `${http}${queue} createServer(req => {
      ${statement}
      enqueue(req.url);
    });`;
    assert.equal((await audit({ "server.ts": source })).length, 1);
  });
}
