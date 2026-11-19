import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";

async function audit(setup, condition, cap = "", routes = 1) {
  const root = await mkdtemp(join(tmpdir(), "scale-custom-boolean-"));
  try {
    const route = `createServer(req=>{if(${condition})return;${cap}jobs.push(req.url);count++;});`;
    await writeFile(join(root, "server.ts"), `import{createServer}from'node:http';${setup}
      const jobs=[];let count=0;function full(){return count>=10;}
      function drain(job){if(job!==undefined)count--;}
      setInterval(()=>drain(jobs.shift()),10);${route.repeat(routes)}`);
    return await detectQueueBackpressure(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const [setup, condition] of [
  ["const guard={Boolean(){return false;}};", "guard.Boolean(full())"],
  ["const guard={Boolean:()=>false};", "guard.Boolean(full())"],
  ["const guard={'Boolean':()=>false};", "guard['Boolean'](full())"],
  ["const guard={Boolean:()=>false};const key='Boolean';", "guard[key](full())"],
  ["const guard={Boolean:()=>false};const cast=guard.Boolean;", "cast(full())"],
  ["const guard={Boolean:()=>false};const first=guard.Boolean;const cast=first;", "cast(full())"],
  ["const guard={Boolean:()=>false};", "guard.Boolean.call(null,full())"],
  ["const guard={Boolean:()=>false};", "guard.Boolean.apply(null,[full()])"],
  ["const guard={Boolean:()=>false};const cast=guard.Boolean.bind(null);", "cast(full())"],
  ["const guard=externalPolicy;", "guard.Boolean(full())"],
  ["const guard={Boolean(){return runtimeFlag;}};", "guard.Boolean(full())"],
  ["const guard={Boolean};guard.Boolean=()=>false;", "guard.Boolean(full())"],
  ["const guard={Boolean};Object.assign(guard,{Boolean:()=>false});", "guard.Boolean(full())"],
  ["const guard={Boolean:()=>false};const cast=guard.Boolean;guard.Boolean=Boolean;", "cast(full())"],
  ["const globalThis={Boolean:()=>false};", "globalThis.Boolean(full())"],
]) {
  test(`custom Boolean cannot hide an unsafe queue: ${setup} ${condition}`, async () => {
    assert.equal((await audit(setup, condition)).length, 1);
  });
}

for (const setup of [
  "const guard={Boolean(){return false;}};",
  "const guard={Boolean(){return true;}};",
  "const guard=externalPolicy;",
  "const guard={Boolean};guard.Boolean=()=>false;",
]) {
  test(`independent capacity remains effective beside a custom Boolean: ${setup}`, async () => {
    assert.deepEqual(await audit(setup, "guard.Boolean(full())", "if(count>=10)return;"), []);
  });
}

for (const [setup, condition] of [
  ["", "Boolean(full())"],
  ["const guard=globalThis;", "guard.Boolean(full())"],
  ["const guard=globalThis;const cast=guard.Boolean;", "cast(full())"],
  ["const cast=Boolean;globalThis.Boolean=()=>false;", "cast(full())"],
]) {
  test(`proven native Boolean keeps a bounded queue quiet: ${setup} ${condition}`, async () => {
    assert.deepEqual(await audit(setup, condition), []);
  });
}

for (const setup of ["const guard={Boolean(){return true;}};", "const guard={Boolean};"]) {
  test(`custom wrapper return semantics remain review-required: ${setup}`, async () => {
    assert.equal((await audit(setup, "guard.Boolean(full())")).length, 1);
  });
}

test("repeated custom Boolean route guards reuse bounded helper work", async () => {
  assert.equal((await audit("const guard={Boolean:()=>false};", "guard.Boolean(full())", "", 250)).length, 1);
});
