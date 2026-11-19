import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { runAudit } from "../dist/runner.js";
import { planCodemod } from "../dist/codemod.js";
import { Workspace } from "../dist/workspace.js";
import { AnalysisBudget } from "../dist/analysisBudget.js";

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), "scale-http-module-effects-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) await writeFile(join(root, name), source);
  return root;
}
const route = body => "import axios from 'axios';\nimport './setup.mjs';\nexport function GET() {\n " + body + "\n}";
const findings = (report, id, file = "route.mjs") => report.findings.filter(item => item.id === id && item.file === file);
const timeouts = report => findings(report, "outbound-no-timeout");
const setup = source => "import http from 'axios';\n" + source;
const withoutImports = source => source.replace(/^import[^;]*;\n/gm, "").replace("export ", "");

for (const [label, write, call, patches, expected] of [
  ["POST replaces GET", "http.get = http.post", "return axios.get('/health', {id: 123})", 1, ["post", {id:123}, 5000]],
  ["GET replaces POST", "http.post = http.get", "return axios.post('/health', {id: 123})", 1, ["get", null, 5000]],
  ["a local method replaces GET", "http.get = (...args) => ['local', args.length, null]", "return axios.get('/health')", 0, ["local", 1, null]],
]) test(`startup import preserves Axios arguments when ${label}`, async t => {
  const source = route(call);
  const root = await fixture(t, {"route.mjs":source, "setup.mjs": setup(write)});
  const report = await runAudit(root, {codemod:"apply"});
  assert.equal(report.complete, true);
  assert.equal(timeouts(report).length, patches);
  assert.equal(report.codemod.appliedEdits, patches);
  const patched = await readFile(join(root, "route.mjs"), "utf8");
  const axios = {get: (_url, config) => ["get", null, config?.timeout],
    post: (_url, data, config) => ["post", data, config?.timeout]};
  const value = vm.runInNewContext(write + "\n" + withoutImports(patched) + "\nGET()", {axios, http:axios});
  assert.deepEqual(JSON.parse(JSON.stringify(value)), expected);
  if (!patches) assert.equal(source, patched);
});

for (const [label, write, config, count, confidence] of [
  ["positive default", "http.defaults.timeout = 250", "", 0],
  ["bracket default", "http['defaults']['timeout'] = 250", "", 0],
  ["captured defaults object", "const settings = http.defaults; settings.timeout = 250", "", 0],
  ["positive explicit override", "http.defaults.timeout = 0", ", {timeout:50}", 0],
  ["zero explicit override", "http.defaults.timeout = 250", ", {timeout:0}", 1, "medium"],
  ["conditional default", "if (flag) http.defaults.timeout = 250", "", 1, "low"],
  ["opaque defaults mutation", "Object.assign(http.defaults, options)", "", 1, "low"],
  ["inherited cancellation", "http.defaults.signal = controller.signal", "", 1, "low"],
]) test(`Axios preserves ${label} across side-effect imports`, async t => {
  const source = route(`return axios.get('/health'${config})`);
  const root = await fixture(t, {"route.mjs":source, "setup.mjs":setup(write)});
  const report = await runAudit(root, {codemod:"apply"});
  assert.equal(report.complete, true);
  assert.equal(timeouts(report).length, count);
  if (count) assert.equal(timeouts(report)[0].confidence, confidence);
  assert.equal(report.codemod.appliedEdits, 0);
  assert.equal(await readFile(join(root, "route.mjs"), "utf8"), source);
});

test("a disconnected defaults setter cannot supply another service's timeout", async t => {
  const root = await fixture(t, {"other.mjs":setup("http.defaults.timeout = 250"),
    "route.mjs":"import axios from 'axios';\nexport function GET(){\n return axios.get('/health');\n}"});
  const report = await runAudit(root, {codemod:"apply"});
  assert.equal(report.complete, true);
  assert.equal(timeouts(report).length, 1);
  assert.equal(report.codemod.appliedEdits, 1);
});

test("dynamic imports, unordered sibling imports and cycles cannot certify a native argument position", async t => {
  for (const files of [
    {"entry.mjs":"import './route.mjs'; import './setup.mjs';"},
    {"entry.mjs":"export async function load() { await import('./setup.mjs'); return import('./route.mjs'); }"},
    {"entry.mjs":"import './route.mjs';", cycle:true},
  ]) {
    const cycle = files.cycle; delete files.cycle;
    const source = (cycle ? "import './setup.mjs';\n" : "") + "import axios from 'axios';\nexport function GET(){\n return axios.get('/health', {id:123});\n}";
    const root = await fixture(t, {...files, "setup.mjs":(cycle ? "import './route.mjs';\n" : "") + setup("http.get = http.post"), "route.mjs":source});
    const report = await runAudit(root, {codemod:"apply"});
    assert.equal(report.complete, true);
    assert.equal(report.codemod.appliedEdits, 0);
    assert.equal(await readFile(join(root, "route.mjs"), "utf8"), source);
  }
});

for (const [label, call, count] of [
  ["bracket default reset", "api['defaults'].timeout = 0;\nreturn api.get('/health');", 1],
  ["POST body is not config", "api.get = api.post;\nreturn api.get('/health', {timeout:250}, {timeout:0});", 1],
  ["explicit POST timeout", "api.get = api.post;\nreturn api.get('/health', {}, {timeout:250});", 0],
  ["local replacement", "api.get = () => 1;\nreturn api.get('/health');", 0],
  ["created client keeps a snapshot", "axios.defaults.timeout = 250;\nreturn api.get('/health', {timeout:0});", 1],
]) test(`created client keeps its own method and defaults for ${label}`, async t => {
  const root = await fixture(t, {"route.mjs":"import axios from 'axios';\nconst api = axios.create({timeout:250});\nexport function GET(){\n" + call + "\n}"});
  const report = await runAudit(root, {codemod:"apply"});
  assert.equal(report.complete, true);
  assert.equal(timeouts(report).length, count);
  assert.equal(report.codemod.appliedEdits, 0);
});

test("the created client's current verb controls the config position", async t => {
  const root = await fixture(t, {"route.mjs":"import axios from 'axios';\nconst api = axios.create({});\napi.get = api.post;\nexport function GET(){return api.get('/health',{timeout:250});}"});
  const report = await runAudit(root);
  assert.equal(report.complete, true);
  assert.equal(timeouts(report).length, 1);
  assert.equal(timeouts(report)[0].confidence, "medium");
});

for (const [expr, timeout, retry] of [
  ["axios.isCancel(error)",0,0], ["axios('/health')",1,1], ["axios.getUri({})",0,0],
  ["axios.postForm('/health', {timeout:250})",1,1], ["axios.putForm('/health', {}, {timeout:250})",0,1],
  ["axios.patchForm('/health', {}, {timeout:0})",1,1],
]) test(`only real outbound Axios calls supply timeout/retry evidence for ${expr}`, async t => {
  const root = await fixture(t, {"route.mjs":`import axios from 'axios';\nexport function GET(){return ${expr};}`});
  const report = await runAudit(root);
  assert.equal(report.complete, true);
  assert.equal(timeouts(report).length, timeout);
  assert.equal(findings(report, "no-retry-strategy").length, retry);
});

for (const separator of ["\n", "\r\n", ";\n"]) for (const member of [false,true]) for (const restored of [false,true]) {
  test(`adjacent ${member ? "member" : "binding"} writes select the ${restored ? "restored" : "replaced"} native call with ${JSON.stringify(separator)}`, async t => {
    const source = member
      ? "import axios from 'axios'\nconst saved = axios.get\nconst local = (...args) => args.length\naxios.get = local" + (restored ? "\naxios.get = saved" : "") + separator + "axios.get('offline')\n"
      : "import nativeFetch from 'node-fetch'\nconst local = (...args) => args.length\nlet request = " + (restored ? "local\nrequest = nativeFetch" : "nativeFetch\nrequest = local") + separator + "request('offline')\n";
    const root = await fixture(t, {"route.mjs":source});
    const report = await runAudit(root, {codemod:"apply"});
    assert.equal(report.complete, true);
    assert.equal(timeouts(report).length, Number(restored));
    assert.equal(findings(report, "no-retry-strategy").length, Number(restored));
    if (!member) {
      assert.equal(findings(report, "floating-promise").length, Number(restored));
      assert.equal(findings(report, "missing-rejection-handler").length, Number(restored));
    }
    assert.equal(report.codemod.appliedEdits, Number(restored));
    if (!restored) assert.equal(await readFile(join(root, "route.mjs"), "utf8"), source);
  });
}
test("an imported startup patch replaces the global fetch for timeout and retry reporting", async t => {
  const source = "import './setup.mjs';\nexport function GET(){return fetch('offline');}";
  const root = await fixture(t, {"setup.mjs":"globalThis.fetch = (...args) => args.length;", "route.mjs":source});
  const report = await runAudit(root, {codemod:"apply"});
  assert.equal(report.complete, true);
  assert.equal(timeouts(report).length, 0);
  assert.equal(findings(report,"no-retry-strategy").length, 0);
  assert.equal(await readFile(join(root,"route.mjs"),"utf8"), source);
});
test("an unresolved load in another service cannot erase a visible fetch or retry finding", async t => {
  const source = "export async function GET(options, init){return await fetch(options.jwks_uri, init);}";
  const root = await fixture(t, {"loader.mjs":"export const load = specifier => import(specifier);",
    "mock.mjs":"globalThis.fetch = () => 1;", "route.mjs":source});
  const report = await runAudit(root, {codemod:"apply"});
  assert.equal(report.complete, true);
  assert.equal(timeouts(report).length, 1);
  assert.equal(findings(report,"no-retry-strategy").length, 1);
  assert.equal(report.codemod.appliedEdits, 0);
});

for (const [label, setupSource, expected] of [
  ["direct namespace forwarding", "export * as pg from 'pg';",1],
  ["local namespace forwarding", "export * as pg from './native.mjs';",1],
  ["mutation in an intermediate re-export", "import {pg} from './bridge.mjs'; pg.Pool = class Local {}; export {pg};",0],
]) test(`PostgreSQL namespace identity includes ${label}`, async t => {
  const root = await fixture(t, {"native.mjs":"export {Pool} from 'pg';", "bridge.mjs":"export * as pg from 'pg';", "setup.mjs":setupSource,
    "route.mjs":"import {pg} from './setup.mjs'; export function GET(){return new pg.Pool();}"});
  const report = await runAudit(root);
  assert.equal(report.complete, true);
  assert.equal(findings(report,"per-request-client").length, expected);
});

for (const [options, expected] of [[undefined,1],[{},1],[{paths:{"unused":["./fs.mjs"]}},1],[{baseUrl:"."},0],[{paths:{fs:["./fs.mjs"]}},0]]) {
  test(`bare Node imports require an explicit resolution mapping: ${JSON.stringify(options)}`, async t => {
    const root = await fixture(t, {"route.mjs":"import {readFileSync as read} from 'fs'; export function GET(){return read('input.txt');}",
      "fs.mjs":"export const readFileSync = () => 'local';", ...(options ? {"tsconfig.json":JSON.stringify({compilerOptions:options})} : {})});
    const report = await runAudit(root);
    assert.equal(report.complete, true);
    assert.equal(findings(report,"sync-io").filter(f=>f.severity==="high").length, expected);
  });
}
test("single-file fixes can use verified sibling effects and standalone plans keep unseen effects manual", async t => {
  const source = route("return axios.get('/health', {id:123})");
  const root = await fixture(t, {"setup.mjs":setup("http.get = http.post"), "route.mjs":source});
  const single = await runAudit(join(root,"route.mjs"));
  assert.equal(planCodemod(root, timeouts(single)).patched, 0);
  const report = await runAudit(join(root,"route.mjs"), {codemod:"apply"});
  assert.equal(report.complete, true);
  assert.equal(report.coverage.analyzed, 1);
  assert.equal(report.codemod.appliedEdits, 1);
  assert.match(await readFile(join(root,"route.mjs"),"utf8"), /\{id:123\}, \{ timeout: 5000 \}/);
});
test("standalone plans need a project graph when an incoming entry can configure the route", async t => {
  const source = "import axios from 'axios';\nexport function GET(){\n return axios.get('/health', {id:123});\n}";
  const isolated = await fixture(t, {"route.mjs":source});
  const isolatedFinding = timeouts(await runAudit(isolated));
  assert.equal(planCodemod(isolated, isolatedFinding).patched, 1);
  const root = await fixture(t, {"route.mjs":source, "setup.mjs":setup("http.get = http.post"),
    "entry.mjs":"import './setup.mjs'; export {GET} from './route.mjs';"});
  const finding = timeouts(await runAudit(join(root, "route.mjs")));
  assert.equal(planCodemod(root, finding).patched, 0);
  const partial = await Workspace.load(root, "route.mjs");
  assert.equal(planCodemod(root, finding, partial.units.map(unit => unit.sf)).patched, 0);
});
test("repeated route sites share module and defaults evidence within existing budgets", async t => {
  const work = [];
  const take = AnalysisBudget.prototype.take;
  try {
    for (const size of [300,600]) {
      let used = 0;
      AnalysisBudget.prototype.take = function(units=1) { if(this.label === "Module mutation provenance") used += units; return take.call(this,units); };
      const root = await fixture(t, {"setup.mjs":setup("http.defaults.timeout = 250"), "route.mjs":route("return [\n" + "axios.get('/health'),\n".repeat(size) + "];")});
      const report = await runAudit(root);
      assert.equal(report.complete, true);
      assert.equal(timeouts(report).length, 0);
      work.push(used);
    }
  } finally { AnalysisBudget.prototype.take = take; }
  assert.ok(work[0] > 0 && work[1] < work[0] * 2.2, String(work));
});
