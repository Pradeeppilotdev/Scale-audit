import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectFloatingPromises } from "../dist/detectors/floatingPromise.js";

async function findings(source) {
  const root = await mkdtemp(join(tmpdir(), "scale-promise-value-identity-"));
  try {
    await writeFile(join(root, "server.ts"), source);
    return (await detectFloatingPromises(root)).map(finding => finding.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const unhandled = ["unhandled-rejection"];
const floating = ["floating-promise"];
for (const [source, expected] of [
  ["let p=Promise.resolve(); p={then(){}}; p.then(()=>{});", []],
  ["let p={then(){}}; p=Promise.resolve(); p.then(()=>{});", unhandled],
  ["let p=Promise.resolve(); const captured=p; p={then(){}}; captured.then(()=>{});", unhandled],
  ["let p={then(){}}; const captured=p; p=Promise.resolve(); captured.then(()=>{});", []],
  ["let p=Promise.resolve(); if(flag)p={then(){}}; p.then(()=>{});", []],
  ["let p=Promise.resolve(); function replace(){p={then(){}}} replace(); p.then(()=>{});", []],
]) {
  test(`promise values use the binding at the read: ${source}`, async () => {
    assert.deepEqual(await findings(source), expected);
  });
}

for (const access of ["api.pending", "api['pending']"]) {
  for (const [setup, expected] of [
    ["const api={pending:Promise.resolve()};", unhandled],
    [`const api={pending:Promise.resolve()}; ${access}={then(){}};`, []],
    [`const api={pending:{then(){}}}; ${access}=Promise.resolve();`, unhandled],
    [`const api={pending:Promise.resolve()}; if(flag)${access}={then(){}};`, []],
  ]) {
    test(`promise member values preserve writes: ${setup}`, async () => {
      assert.deepEqual(await findings(`${setup} ${access}.then(()=>{});`), expected);
    });
  }
}

for (const [setup, expected] of [
  ["const api={pending:Promise.resolve()}; const captured=api.pending; api.pending={then(){}};", unhandled],
  ["const api={pending:{then(){}}}; const captured=api.pending; api.pending=Promise.resolve();", []],
]) {
  test(`a captured member value preserves capture timing: ${setup}`, async () => {
    assert.deepEqual(await findings(`${setup} captured.then(()=>{});`), expected);
  });
}

for (const access of ["handlers.error", "handlers['error']"]) {
  for (const value of ["undefined", "null", "42", "false", "'error'", "{}", "()=>{}"] ) {
    test(`rejection handlers inspect known ${access} initializer ${value}`, async () => {
      assert.deepEqual(await findings(`const handlers={error:${value}}; Promise.reject('x').catch(${access});`), value === "()=>{}" ? [] : unhandled);
    });
  }
  for (const [setup, expected] of [
    [`const handlers={error:null}; ${access}=()=>{};`, []],
    [`const handlers={error:()=>{}}; ${access}=null;`, unhandled],
    [`const handlers={error:null}; if(flag)${access}=()=>{};`, []],
  ]) {
    test(`rejection handlers respect member writes: ${setup}`, async () => {
      assert.deepEqual(await findings(`${setup} Promise.reject('x').catch(${access});`), expected);
    });
  }
}

test("same-named handler members retain separate identities", async () => {
  assert.deepEqual(await findings("const a={error:()=>{}},b={error:()=>{}};a.error=null;Promise.reject('x').catch(a.error);Promise.reject('x').catch(b.error);"), unhandled);
});

test("unknown property handlers remain conservative", async () => {
  assert.deepEqual(await findings("Promise.reject('x').catch(unknown.error); Promise.reject('x').catch(unknown['error']);"), []);
});

for (const [setup, expected] of [
  ["const api={run:async()=>{}};", floating],
  ["const api={run:async()=>{}}; api['run']=()=>{};", []],
  ["const api={run:()=>{}}; api['run']=async()=>{};", floating],
  ["const api={run:async()=>{}}; if(flag)api['run']=()=>{};", []],
]) {
  test(`computed async member calls respect writes: ${setup}`, async () => {
    assert.deepEqual(await findings(`${setup} api['run']();`), expected);
  });
}

for (const expression of ["(f)", "(f as ()=>Promise<void>)", "(f satisfies ()=>Promise<void>)", "(<()=>Promise<void>>f)", "f!"]) {
  test(`erased callable wrapper retains async origin: ${expression}`, async () => {
    assert.deepEqual(await findings(`const f=async()=>{}; ${expression}();`), floating);
    assert.deepEqual(await findings(`const f=()=>{}; ${expression}();`), []);
  });
}

for (const expression of ["(f())", "(f() as Promise<void>)", "(f() satisfies Promise<void>)", "(<Promise<void>>f())", "f()!"]) {
  test(`erased result wrapper retains discarded promise: ${expression}`, async () => {
    assert.deepEqual(await findings(`const f=async()=>{}; ${expression};`), floating);
  });
}

for (const expression of ["(Promise.resolve().then(()=>{}))", "(Promise.resolve().then(()=>{}) as Promise<void>)", "(Promise.resolve().then(()=>{}) satisfies Promise<void>)", "(<Promise<void>>Promise.resolve().then(()=>{}))"]) {
  test(`erased result wrapper retains discarded rejection chain: ${expression}`, async () => {
    assert.deepEqual(await findings(`${expression};`), unhandled);
  });
}

for (const [source, expected] of [
  ["Promise['reject']('x');", unhandled],
  ["Promise['resolve']()['then'](()=>{});", unhandled],
  ["Promise.resolve()['catch'](null);", unhandled],
  ["Promise.resolve()['catch'](()=>{});", []],
  ["const fake={resolve(){return {then(){}}}}; fake['resolve']()['then'](()=>{});", []],
  ["const api={run:async()=>{}}; async function safe(){await api['run']();return api['run']();} void api['run']();", []],
]) {
  test(`computed chain names and consumed results retain behavior: ${source}`, async () => {
    assert.deepEqual(await findings(source), expected);
  });
}
