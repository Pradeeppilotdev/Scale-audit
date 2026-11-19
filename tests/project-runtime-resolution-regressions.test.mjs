import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import ts from "typescript";
import { projectFor } from "../dist/bindings.js";
import { Workspace } from "../dist/workspace.js";
import { runAudit } from "../dist/runner.js";

const config = (options, parent) => JSON.stringify({
  ...(parent ? { extends: parent } : {}),
  compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", ...options },
});
const custom = "export default {get(...args) { return args; }};";
const axios = "export {default} from 'axios';";
async function fixture(t, files) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "scale-runtime-resolution-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
  return root;
}
const compareWithCompiler = async (root, from, configFile, expected) => {
  const workspace = await Workspace.load(root);
  const project = projectFor(workspace.units.find(unit => unit.rel === from).sf);
  const parsed = ts.getParsedCommandLineOfConfigFile(join(root, configFile), {}, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic(diagnostic) { assert.fail(diagnostic.messageText); },
  });
  for (const [specifier, target] of Object.entries(expected)) {
    const official = ts.resolveModuleName(specifier, join(root, from), parsed.options, ts.sys).resolvedModule;
    const file = official && relative(root, official.resolvedFileName).split("\\").join("/");
    assert.equal(file, target, specifier);
    const eligible = file?.startsWith("node_modules/") ? undefined : file;
    assert.equal(project.resolve(from, specifier), eligible, specifier);
    assert.equal(project.resolve(from, specifier), eligible, "cached " + specifier);
  }
};

for (const [name, parent, child, expected] of [
  ["child overrides paths", {}, { paths: { client: ["./client.ts"] } }, "packages/app/client.ts"],
  ["child inherits paths", { paths: { client: ["./client.ts"] } }, {}, "client.ts"],
  ["child paths use inherited baseUrl", { baseUrl: "./shared" }, { paths: { client: ["./client.ts"] } }, "shared/client.ts"],
]) test(`path mappings use the declaring config or effective baseUrl when ${name}`, async t => {
  const from = "packages/app/route.ts", configFile = "packages/app/tsconfig.json";
  const root = await fixture(t, { "tsconfig.json": config(parent), [configFile]: config(child, "../../tsconfig.json"),
    "client.ts": axios, "packages/app/client.ts": custom, "shared/client.ts": custom,
    [from]: "import api from 'client';export function GET(){return api.get('/health', {id:123});}" });
  await compareWithCompiler(root, from, configFile, { client: expected });
  const report = await runAudit(root, { codemod: "diff" });
  assert.equal(report.complete, true);
  assert.equal(report.findings.filter(f => f.id === "outbound-no-timeout").length, expected === "client.ts" ? 1 : 0);
  assert.equal(report.codemod.edits.length, 0);
});

test("TypeScript wildcard aliases require disjoint matching prefix and suffix and exactly one wildcard", async t => {
  const root = await fixture(t, { "tsconfig.json": config({ paths: {
    "@example/cache*cache": ["./shim.ts"], "invalid*two*stars": ["./shim.ts"], "empty*tail": ["./star-*.ts"],
    "@substitution/*": ["./named-*.ts"],
  } }), "shim.ts": axios, "star-.ts": axios, "named-dollar$sign.ts": custom, "named-dollar$$sign.ts": axios,
    "named-suffix.ts.ts": custom,
    "node_modules/@example/cache/package.json": '{"name":"@example/cache","main":"index.cjs"}',
    "node_modules/@example/cache/index.cjs": "module.exports = { get(...args) {return args;} };",
    "route.ts": "import client from '@example/cache';export function GET(){return client.get('/health', {id:123});}" });
  await compareWithCompiler(root, "route.ts", "tsconfig.json", {
    "@example/cache": "node_modules/@example/cache/index.cjs", "@example/cache-mid-cache": "shim.ts",
    "invalid*two*stars": undefined, emptytail: undefined,
    "@substitution/dollar$$sign": "named-dollar$sign.ts", "@substitution/suffix$'": "named-suffix.ts.ts",
  });
  const report = await runAudit(root, { codemod: "diff" });
  assert.equal(report.complete, true);
  assert.equal(report.findings.filter(f => f.id === "outbound-no-timeout").length, 0);
  assert.equal(report.codemod.edits.length, 0);
});

for (const configMode of ["paths", "baseUrl"]) for (const single of [false, true]) {
  test(`a ${configMode} HTTP alias preserves the actual Node client payload in ${single ? "file" : "folder"} mode`, async t => {
    const options = configMode === "paths" ? { paths: { "@example/cache": ["./shim.mjs"] } } : { baseUrl: "." };
    const shim = configMode === "paths" ? "shim.mjs" : "@example/cache/index.mjs";
    const root = await fixture(t, { "tsconfig.json": config(options), [shim]: axios,
      "node_modules/@example/cache/package.json": '{"name":"@example/cache","main":"index.cjs"}',
      "node_modules/@example/cache/index.cjs": "module.exports = { get(...args) {return args;} };",
      "bridge.mjs": "export {default} from '@example/cache';",
      "route.mjs": "import api from './bridge.mjs';export function GET(){return api.get('/health', {id:123});}",
      "independent.mjs": "export function POST(){return fetch('https://example.test');}" });
    const route = join(root, "route.mjs"), url = pathToFileURL(route);
    assert.deepEqual((await import(url.href)).GET(), ["/health", { id: 123 }]);
    const report = await runAudit(single ? route : root, { codemod: "apply" });
    assert.equal(report.complete, true);
    assert.deepEqual((await import(url.href + "?after")).GET(), ["/health", { id: 123 }]);
    assert.deepEqual(report.codemod.edits.map(edit => edit.file), single ? [] : ["independent.mjs"]);
  });
}

test("a supported package import mapping still provides runtime evidence for a safe timeout edit", async t => {
  const root = await fixture(t, { "package.json": '{"type":"module","imports":{"#client":"./shim.mjs"}}',
    "tsconfig.json": config({ paths: { "#client": ["./unused.mjs"] } }), "shim.mjs": axios, "unused.mjs": custom,
    "route.mjs": "import api from '#client';export function GET(){return api.get('/health');}" });
  const report = await runAudit(root, { codemod: "diff" });
  assert.equal(report.complete, true);
  assert.deepEqual(report.codemod.edits.map(edit => edit.file), ["route.mjs"]);
});
