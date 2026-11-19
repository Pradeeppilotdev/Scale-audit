import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AnalysisBudget, AnalysisLimitError } from "../dist/analysisBudget.js";
import { detectUnboundedConcurrency } from "../dist/detectors/unboundedConcurrency.js";

async function withSource(source, run = detectUnboundedConcurrency) {
  const root = await mkdtemp(join(tmpdir(), "scale-concurrency-eager-hook-review-"));
  try {
    await writeFile(join(root, "route.ts"), source);
    return await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

const header = "import pLimit from 'p-limit';const limit=pLimit(5);";
const sourceFor = (expression, setup = "") => `${header}${setup}export function GET(users){return Promise.all(users.map(user=>limit(()=>fetch(user.url),${expression})));}`;

for (const [name, expression, expected] of [
  ["toJSON method", "JSON.stringify({toJSON(){fetch(user.url);return 1;}})", 1],
  ["toJSON function property", "JSON.stringify({toJSON:()=>{fetch(user.url);return 1;}})", 1],
  ["own JSON getter", "JSON.stringify({get item(){fetch(user.url);return 1;}})", 1],
  ["toJSON getter returning a callback", "JSON.stringify({get toJSON(){return ()=>{fetch(user.url);return 1;};}})", 1],
  ["pure toJSON getter returning a callback", "JSON.stringify({get toJSON(){return ()=>1;}})", 0],
  ["unconditional serializer getter replaces other getters", "JSON.stringify({get toJSON(){return ()=>1;},get item(){fetch(user.url);return 1;}})", 0],
  ["serializer getter fallthrough retains other getters", "JSON.stringify({get toJSON(){if(flag)return ()=>1;},get item(){fetch(user.url);return 1;}})", 1],
  ["unknown toJSON callback", "JSON.stringify({toJSON:externalHook})", 1],
  ["noncallable toJSON", "JSON.stringify({toJSON:1,item:2})", 0],
  ["pure toJSON method", "JSON.stringify({toJSON(){return 1;}})", 0],
  ["pure JSON getter", "JSON.stringify({get item(){return 1;}})", 0],
  ["ordinary deferred method", "JSON.stringify({deferred(){fetch(user.url);}})", 0],
  ["ordinary deferred function property", "JSON.stringify({deferred:()=>fetch(user.url)})", 0],
  ["toJSON returning an object with a getter", "JSON.stringify({toJSON(){return {get item(){fetch(user.url);return 1;}};}})", 1],
  ["getter returning an object with toJSON", "JSON.stringify({get item(){return {toJSON(){fetch(user.url);return 1;}};}})", 1],
  ["pure nested getter result", "JSON.stringify({get item(){return {get nested(){return 1;}};}})", 0],
  ["toJSON replaces the object before other getters run", "JSON.stringify({toJSON(){return 1;},get item(){fetch(user.url);return 1;}})", 0],
  ["toJSON returning this retains property getters", "JSON.stringify({toJSON(){return this;},get item(){fetch(user.url);return 1;}})", 1],
  ["data property overwrites a getter", "JSON.stringify({get item(){fetch(user.url);return 1;},item:2})", 0],
  ["getter overwrites a data property", "JSON.stringify({item:2,get item(){fetch(user.url);return 1;}})", 1],
  ["literal computed toJSON", "JSON.stringify({['toJSON'](){fetch(user.url);return 1;}})", 1],
  ["unknown computed serializer", "JSON.stringify({[hookName]:()=>fetch(user.url)})", 1],
  ["JSON replacer", "JSON.stringify({item:1},(key,value)=>{fetch(user.url);return value;})", 1],
  ["pure JSON replacer", "JSON.stringify({item:1},(key,value)=>value)", 0],
  ["JSON reviver", "JSON.parse('{}',(key,value)=>{fetch(user.url);return value;})", 1],
  ["pure JSON reviver", "JSON.parse('{}',(key,value)=>value)", 0],
  ["replacer returns a getter-bearing object", "JSON.stringify(1,()=>({get item(){fetch(user.url);return 1;}}))", 1],
  ["Object.values getter", "Object.values({get item(){fetch(user.url);return 1;}})", 1],
  ["Object.entries getter", "Object.entries({get item(){fetch(user.url);return 1;}})", 1],
  ["Object.keys does not read getters", "Object.keys({get item(){fetch(user.url);return 1;}})", 0],
  ["own property names do not read getters", "Object.getOwnPropertyNames({get item(){fetch(user.url);return 1;}})", 0],
  ["Object.values does not invoke function properties", "Object.values({toJSON(){fetch(user.url);return 1;}})", 0],
  ["Object.entries does not traverse nested getters", "Object.entries({nested:{get item(){fetch(user.url);return 1;}}})", 0],
  ["Object.values does not invoke a returned function", "Object.values({get item(){return ()=>fetch(user.url);}})", 0],
  ["pure Object.values getter", "Object.values({get item(){return 1;}})", 0],
  ["getter calls an unknown helper", "Object.values({get item(){return externalHook();}})", 1],
  ["getter survives a matching setter", "Object.entries({get item(){fetch(user.url);return 1;},set item(value){}})", 1],
]) {
  test(`eager builtin hook: ${name}`, async () => {
    const findings = await withSource(sourceFor(expression));
    assert.equal(findings.length, expected);
    if (expected) assert.equal(findings[0].id, "unbounded-concurrency");
  });
}

for (const [name, setup, expression, expected] of [
  ["immutable object alias", "const payload={toJSON(){fetch(url);return 1;}};", "JSON.stringify(payload)", 1],
  ["pure immutable object alias", "const payload={toJSON(){return 1;}};", "JSON.stringify(payload)", 0],
  ["chained immutable object alias", "const payload={get item(){return 1;}};const alias=payload;", "Object.values(alias)", 0],
  ["immutable function alias", "const hook=()=>{fetch(url);return 1;};const alias=hook;", "JSON.stringify({toJSON:alias})", 1],
  ["pure immutable function alias", "const hook=()=>1;const alias=hook;", "JSON.stringify({toJSON:alias})", 0],
  ["member replacement", "const payload={toJSON(){return 1;}};payload.toJSON=()=>fetch(url);", "JSON.stringify(payload)", 1],
  ["alias member replacement", "const payload={toJSON(){return 1;}};const alias=payload;alias.toJSON=()=>fetch(url);", "JSON.stringify(payload)", 1],
  ["array slot escape", "const payload={toJSON(){return 1;}};const holder=[payload];holder[0].toJSON=()=>fetch(url);", "JSON.stringify(payload)", 1],
  ["property assignment escape", "const payload={toJSON(){return 1;}};const holder={};holder.value=payload;holder.value.toJSON=()=>fetch(url);", "JSON.stringify(payload)", 1],
  ["mutable variable capture escape", "const payload={toJSON(){return 1;}};let alias=payload;alias.toJSON=()=>fetch(url);", "JSON.stringify(payload)", 1],
  ["mutable variable assignment escape", "const payload={toJSON(){return 1;}};let alias;alias=payload;alias.toJSON=()=>fetch(url);", "JSON.stringify(payload)", 1],
  ["direct immutable alias keeps pure serialization", "const payload={toJSON(){return 1;}};const alias=payload;", "JSON.stringify(payload)", 0],
  ["descriptor overwrite", "const payload={get item(){return 1;}};Object.defineProperty(payload,'item',{get(){fetch(url);return 1;}});", "Object.values(payload)", 1],
  ["alias descriptor overwrite", "const payload={item:1};const alias=payload;Object.defineProperty(alias,'item',{get(){fetch(url);return 1;}});", "Object.entries(payload)", 1],
  ["nested member alias mutation", "const payload={nested:{get item(){return 1;}}};const alias=payload.nested;Object.defineProperty(alias,'item',{get(){fetch(url);return 1;}});", "JSON.stringify(payload)", 1],
  ["serializer mutates its receiver", "const payload={toJSON(){this.toJSON=()=>fetch(url);return 1;}};", "JSON.stringify(payload)", 1],
  ["getter installs a descriptor on its receiver", "const payload={get item(){Object.defineProperty(this,'later',{get(){fetch(url);return 1;}});return 1;}};", "Object.values(payload)", 1],
  ["assigned serializer", "const payload={item:1};Object.assign(payload,{toJSON(){fetch(url);return 1;}});", "JSON.stringify(payload)", 1],
  ["escaped object", "const payload={toJSON(){return 1;}};externalUpdate(payload);", "JSON.stringify(payload)", 1],
  ["mutable visible object", "let payload={toJSON(){return 1;}};payload={toJSON(){fetch(url);return 1;}};", "JSON.stringify(payload)", 1],
  ["reassigned hook function", "function hook(){return 1;}hook=()=>fetch(url);", "JSON.stringify({toJSON:hook})", 1],
  ["mutated object still does not make Object.keys read getters", "const payload={item:1};Object.defineProperty(payload,'item',{get(){fetch(url);return 1;}});", "Object.keys(payload)", 0],
]) {
  test(`builtin hook evidence respects ${name}`, async () => {
    assert.equal((await withSource(sourceFor(expression, setup))).length, expected);
  });
}

test("native serialization and value enumeration execute eager hooks before the limiter receives arguments", () => {
  let scheduled = 0;
  const launch = () => { scheduled++; };
  const limit = () => {};
  for (let index = 0; index < 12; index++) {
    limit(() => launch(), JSON.stringify({ toJSON() { launch(); return 1; } }));
    limit(() => launch(), Object.values({ get item() { launch(); return 1; } }));
    limit(() => launch(), Object.keys({ get item() { launch(); return 1; } }));
  }
  assert.equal(scheduled, 24);
});

function wideSource(count) {
  const properties = Array.from({ length: count }, (_, index) => `get item${index}(){return ${index};}`).join(",");
  const calls = Array.from({ length: count }, () => "Promise.all(users.map(user=>limit(()=>fetch(user.url),JSON.stringify(payload))));").join("\n");
  return `${header}const payload={${properties}};export function GET(users){${calls}}`;
}

test("many call sites share completed builtin hook and function-body summaries", async () => {
  const measurements = [];
  for (const count of [250, 500]) {
    await withSource(wideSource(count), async root => {
      const take = AnalysisBudget.prototype.take;
      let work = 0;
      AnalysisBudget.prototype.take = function (units = 1) {
        if (this.label === "Concurrency callback" || this.label === "Concurrency binding writes") work += units;
        return take.call(this, units);
      };
      try {
        assert.deepEqual(await detectUnboundedConcurrency(root), []);
        measurements.push(work);
      } finally { AnalysisBudget.prototype.take = take; }
    });
  }
  assert.ok(measurements[1] < measurements[0] * 2.3, `hook checks should grow near linearly: ${measurements}`);
});

test("an exhausted callback budget cannot certify a visible hook as synchronous", async () => {
  const take = AnalysisBudget.prototype.take;
  AnalysisBudget.prototype.take = function (units = 1) {
    if (this.label === "Concurrency callback") this.remaining = 0;
    return take.call(this, units);
  };
  try {
    await assert.rejects(withSource(sourceFor("JSON.stringify({toJSON(){return 1;}})")),
      error => error instanceof AnalysisLimitError && error.message === "Concurrency callback analysis work budget exceeded");
  } finally { AnalysisBudget.prototype.take = take; }
});

for (const warm of [false, true]) {
  test(`${warm ? "warm" : "cold"} immutable alias caches preserve the resolution depth limit`, async () => {
    const aliases = Array.from({ length: 140 }, (_, index) => `const alias${index}=${index ? `alias${index - 1}` : "payload"};`).join("\n");
    const warmup = warm ? "Promise.all(users.map(user=>limit(()=>fetch(user.url),JSON.stringify(alias100))));" : "";
    const source = `${header}const payload={toJSON(){return 1;}};${aliases}export function GET(users){${warmup}
      return Promise.all(users.map(user=>limit(()=>fetch(user.url),JSON.stringify(alias139))));}`;
    await assert.rejects(withSource(source), error => error instanceof AnalysisLimitError
      && error.message === "Concurrency value resolution depth limit exceeded");
  });

  test(`${warm ? "warm" : "cold"} object hook caches preserve nested inspection depth`, async () => {
    // JSON follows each returned getter value. It does not invoke a second
    // toJSON on the object returned by a toJSON method.
    const values = Array.from({ length: 40 }, (_, index) => `const value${index}={get item(){return ${index ? `value${index - 1}` : "1"};}};`).join("\n");
    const warmup = warm ? "Promise.all(users.map(user=>limit(()=>fetch(user.url),JSON.stringify(value20))));" : "";
    const source = `${header}${values}export function GET(users){${warmup}
      return Promise.all(users.map(user=>limit(()=>fetch(user.url),JSON.stringify(value39))));}`;
    assert.equal((await withSource(source)).length, 1);
  });

  test(`${warm ? "warm" : "cold"} function summaries preserve nested inspection depth`, async () => {
    const functions = Array.from({ length: 70 }, (_, index) => `function format${index}(){return ${index ? `format${index - 1}()` : "1"};}`).join("\n");
    const warmup = warm ? "Promise.all(users.map(user=>format40()));" : "";
    const source = `${functions}export function GET(users){${warmup}return Promise.all(users.map(user=>format69()));}`;
    assert.equal((await withSource(source)).length, 1);
  });
}
