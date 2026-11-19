import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Workspace } from "../dist/workspace.js";
import { executionContexts } from "../dist/executionContext.js";
import { detectSyncIo } from "../dist/detectors/syncIo.js";
import { detectLifecycle } from "../dist/detectors/lifecycle.js";

async function withFiles(files, run) {
  const root = await mkdtemp(join(tmpdir(), "scale-cjs-local-sync-"));
  try {
    for (const [name, source] of Object.entries(files)) await writeFile(join(root, name), source);
    return await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

const http = "import { createServer } from 'node:http'; import * as fs from 'node:fs';";
async function sync(source) {
  return withFiles({ "main.ts": http + source }, async root =>
    (await detectSyncIo(root)).filter(finding => finding.id === "sync-io"));
}

for (const source of [
  "function readFileSync() {} createServer(() => readFileSync());",
  "const readFileSync = () => {}; createServer(() => readFileSync());",
  "const own = { readFileSync() {} }; createServer(() => own.readFileSync());",
  "function require(name) { return { readFileSync() {} }; } const own = require('node:fs'); createServer(() => own.readFileSync());",
]) {
  test(`a proven local implementation is not native blocking I/O: ${source}`, async () => {
    assert.deepEqual(await sync(source), []);
  });
}

for (const source of [
  "createServer(() => fs.readFileSync('live'));",
  "function readFileSync() { return fs.readFileSync('live'); } createServer(() => readFileSync());",
  "createServer(req => req.fs.readFileSync('possible'));",
  "const own = flag ? { readFileSync() {} } : external; createServer(() => own.readFileSync('possible'));",
  "let readFileSync = () => {}; readFileSync = fs.readFileSync; createServer(() => readFileSync('live'));",
  "let readFileSync = () => {}; readFileSync &&= fs.readFileSync; createServer(() => readFileSync('live'));",
  "const own = { readFileSync() {} }; own.readFileSync = fs.readFileSync; createServer(() => own.readFileSync('live'));",
  "function make() { return { readFileSync() {} }; } make &&= external; const own = make(); createServer(() => own.readFileSync('possible'));",
]) {
  test(`native or uncertain operations retain their findings: ${source}`, async () => {
    const findings = await sync(source);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "high");
  });
}

for (const native of [false, true]) {
  test(`${native ? "native createRequire" : "shadowed require"} keeps execution-context imports accurate`, async () => {
    const loader = native ? "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
      : "function require(name) { return {}; }";
    const result = await withFiles({
      "package.json": JSON.stringify({ bin: "cli.ts" }),
      "cli.ts": `${loader} require('./utility.js');`,
      "utility.ts": "export const value = 1;",
    }, async root => {
      const workspace = await Workspace.load(root);
      return executionContexts(root, workspace, () => false);
    });
    assert.equal(result.get("utility.ts")?.cli ?? false, native);
  });
}

for (const native of [false, true]) {
  test(`${native ? "native createRequire" : "shadowed require"} keeps startup shutdown evidence accurate`, async () => {
    const loader = native ? "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
      : "function require(name) { return {}; }";
    const findings = await withFiles({
      "main.ts": `import { createServer } from 'node:http'; ${loader}
        require('./shutdown.cjs'); createServer(() => {}).listen(3000);`,
      "shutdown.cjs": "process.on('SIGTERM', () => {});",
    }, detectLifecycle);
    assert.equal(findings.filter(finding => finding.id === "missing-graceful-shutdown").length, native ? 0 : 1);
  });
}

test("createRequire preserves CommonJS callback identity across files", async () => {
  const findings = await withFiles({
    "main.ts": `import { createRequire } from 'node:module'; import { createServer } from 'node:http';
      const require = createRequire(import.meta.url); const handler = require('./handler.cjs'); createServer(handler);`,
    "handler.cjs": "const fs = require('node:fs'); module.exports = () => fs.readFileSync('live');",
  }, detectSyncIo);
  assert.equal(findings.filter(finding => finding.severity === "high").length, 1);
});

test("createRequire HTTP namespaces establish request entries", async () => {
  const findings = await withFiles({ "main.ts": `import { createRequire } from 'node:module'; import { readFileSync } from 'node:fs';
    const require = createRequire(import.meta.url); const http = require('node:http');
    http.createServer(() => readFileSync('live'));` }, detectSyncIo);
  assert.equal(findings.filter(finding => finding.severity === "high").length, 1);
});
