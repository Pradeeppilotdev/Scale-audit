import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { importedBinding } from "../dist/bindings.js";
import { Workspace } from "../dist/workspace.js";

async function inspect(source, files = {}) {
  const root = await mkdtemp(join(tmpdir(), "scale-commonjs-shadow-"));
  try {
    for (const [name, text] of Object.entries({ "entry.ts": source, ...files })) await writeFile(join(root, name), text);
    const workspace = await Workspace.load(root);
    const unit = workspace.units.find(unit => unit.rel === "entry.ts");
    const reads = [];
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "use") {
        reads.push(importedBinding(node.arguments[0]));
      }
      ts.forEachChild(node, visit);
    };
    visit(unit.sf);
    return { reads, context: unit.ctx };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const [setup, declaration, body] of [
  ["function require(name){return {readFileSync(){}};}", "const fs=require('node:fs');", "use(fs);"],
  ["const require=name=>({readFileSync(){}});", "const {readFileSync:read}=require('node:fs');", "use(read);"],
  ["function require(name){return {readFileSync(){}};}", "const read=require('node:fs').readFileSync;", "use(read);"],
  ["", "function run(require){const fs=require('node:fs');", "use(fs);}"],
]) {
  test(`local require cannot donate imported identity: ${declaration}`, async () => {
    assert.deepEqual((await inspect(setup + declaration + body)).reads, [null]);
  });
}

for (const [declaration, name] of [
  ["const fs=require('node:fs');use(fs);", "*"],
  ["const {readFileSync:read}=require('node:fs');use(read);", "readFileSync"],
  ["const read=require('node:fs').readFileSync;use(read);", "readFileSync"],
]) {
  test(`unshadowed require retains imported identity: ${declaration}`, async () => {
    assert.deepEqual((await inspect(declaration)).reads, [{ module: "node:fs", name }]);
  });
}

for (const source of [
  "function require(name){return {};};const mongoose=require('mongoose');",
  "function load(require){const mongoose=require('mongoose');}",
]) {
  test(`local require cannot supply ORM context: ${source}`, async () => {
    const { context } = await inspect(source);
    assert.equal(context.hasOrmImport, false);
    assert.equal(context.imports.has("mongoose"), false);
  });
}

test("native require still supplies ORM and session context", async () => {
  const { context } = await inspect("const mongoose=require('mongoose');const session=require('express-session');");
  assert.equal(context.hasOrmImport, true);
  assert.equal(context.sessionBindings.has("session"), true);
});

for (const factory of [
  "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);",
  "import {createRequire as makeRequire} from 'module';const require=makeRequire(import.meta.url);",
  "import * as nodeModule from 'node:module';const require=nodeModule.createRequire(import.meta.url);",
]) {
  test(`an immutable explicit native loader preserves provenance: ${factory}`, async () => {
    const { reads, context } = await inspect(`${factory}const fs=require('node:fs');use(fs);const mongoose=require('mongoose');`);
    assert.deepEqual(reads, [{ module: "node:fs", name: "*" }]);
    assert.equal(context.hasOrmImport, true);
  });
}

for (const setup of [
  "function createRequire(){return ()=>({});}const require=createRequire();",
  "const require=require('node:module');",
  "const make=require('node:module').createRequire;const require=make(import.meta.url);",
  "const first=second;const second=require('node:module').createRequire;const require=first(import.meta.url);",
]) {
  test(`a local or self-referential loader factory cannot supply provenance: ${setup}`, async () => {
    assert.deepEqual((await inspect(`${setup}const fs=require('node:fs');use(fs);`)).reads, [null]);
  });
}

for (const [bridge, expected] of [
  ["module.exports=require('node:fs');", { module: "node:fs", name: "readFileSync" }],
  ["const fs=require('node:fs');exports.readFileSync=fs.readFileSync;", { module: "node:fs", name: "readFileSync" }],
  ["const fs=require('node:fs');module.exports={readFileSync:fs.readFileSync};", { module: "node:fs", name: "readFileSync" }],
  ["function require(){return {readFileSync(){}};}module.exports=require('node:fs');", null],
  ["const module={exports:{}};module.exports=require('node:fs');", null],
  ["const exports={};const fs=require('node:fs');exports.readFileSync=fs.readFileSync;", null],
]) {
  test(`CommonJS forwarding retains native loader and export identity: ${bridge}`, async () => {
    assert.deepEqual((await inspect("import {readFileSync as read} from './bridge.js';use(read);", { "bridge.js": bridge })).reads, [expected]);
  });
}
