import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { planCodemod, applyPlan, renderDiff, unifiedDiff } from "../dist/codemod.js";

const fetchSource = 'fetch("https://example.com");\n';
const changedFetchSource = 'fetch("https://example.org");\n';

function finding(id, line = 1, file = "src/app.js") {
  return { id, line, file, category: "test", severity: "high", confidence: "high", snippet: "", message: "test", scaleTrigger: "", suggestedFix: "" };
}

function repo(t, content, file = "src/app.js") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scale-codemod-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return { root, full };
}

function checkPatch(root, diff, file, expected) {
  const check = spawnSync("git", ["--no-pager", "apply", "--check", "-"], { cwd: root, input: diff, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr + "\n" + diff.slice(0, 1000));
  const apply = spawnSync("git", ["--no-pager", "apply", "-"], { cwd: root, input: diff, encoding: "utf8" });
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(fs.readFileSync(path.join(root, file), "utf8"), expected);
}

function manualOnly(plan, count = 1) {
  assert.equal(plan.files.length, 0);
  assert.equal(plan.patched, 0);
  assert.equal(plan.unpatched, count);
  assert.equal(plan.manual.length, count);
  assert.ok(plan.manual.every((e) => !e.safe));
}

test("literal fetch configs produce syntax-valid, applicable, safe timeout fixes", (t) => {
  for (const source of [
    fetchSource,
    'fetch("https://example.com", { method: "GET" });\n',
    'fetch("https://example.com",);\n',
    'fetch(`https://example.com`);\n',
    'fetch(`https://example.com/${id}`);\n',
  ]) {
    const { root, full } = repo(t, source);
    const plan = planCodemod(root, [finding("outbound-no-timeout")]);
    assert.equal(plan.patched, 1);
    assert.equal(plan.files[0].edits[0].safe, true);
    const after = plan.files[0].after;
    assert.equal((after.match(/AbortSignal.timeout/g) ?? []).length, 1);
    const syntax = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: after, encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
    checkPatch(root, renderDiff(plan), "src/app.js", after);
    fs.writeFileSync(full, source);
    assert.deepEqual(applyPlan(root, plan), ["src/app.js"]);
    assert.equal(fs.readFileSync(full, "utf8"), after);
  }
});

test("unknown, spread, existing timeout and ambiguous outbound configs stay manual", (t) => {
  const sources = [
    'fetch("https://example.com", options);', 'fetch("https://example.com", undefined);', "fetch(...args);",
    'fetch("https://example.com", { signal });', 'fetch("https://example.com", { "signal": signal });',
    'fetch("https://example.com", { timeout: 20 });', 'fetch("https://example.com", { ...options });', 'fetch("https://example.com", { [key]: value });',
    'fetch("https://example.com", {}, extra);', 'fetch("https://a.com"); fetch("https://b.com");', 'fetch(fetch("https://example.com"));',
    'https.request(url); fetch("https://example.com");', 'axios(config); fetch("https://example.com");', "fetch(buildUrl());",
    "axios.get(url, config);", "axios.get(url, { timeout: 100 });", "axios.get(url, { signal });",
    "axios.post(url);", "axios.request(url);", "axios.request(config);", "axios.request({}, extra);",
    "axios.get(...args);", "axios.get(url, { ...config });", "axios.get(url, { cancelToken });",
  ];
  for (const source of sources) {
    const { root } = repo(t, source);
    manualOnly(planCodemod(root, [finding("outbound-no-timeout")]));
  }
});

test("fetch Request inputs retain their cancellation signal and configs without suggestions", (t) => {
  for (const call of [
    "fetch(req);",
    "fetch(req, {});",
    'fetch(req, { method: "POST", body });',
    "fetch(req, { signal: otherSignal });",
    "fetch(req, options);",
    'fetch(new Request("https://example.com", { signal: controller.signal }));',
  ]) {
    const source = 'const controller = new AbortController();\n'
      + 'const req = new Request("https://example.com", { signal: controller.signal });\n'
      + `${call}\n`;
    const { root, full } = repo(t, source);
    const plan = planCodemod(root, [finding("outbound-no-timeout", 3)]);
    manualOnly(plan);
    assert.equal(renderDiff(plan), "");
    assert.deepEqual(applyPlan(root, plan), []);
    assert.equal(fs.readFileSync(full, "utf8"), source);
  }
  for (const source of ["fetch(url);", "fetch(url, {});", "fetch(input.url);", "fetch(getInput());", 'fetch(new URL("https://example.com"));']) {
    const { root } = repo(t, source);
    manualOnly(planCodemod(root, [finding("outbound-no-timeout")]));
  }
});

test("axios uses each supported config position, including request(config)", (t) => {
  for (const [source, expected] of [
    ["axios.get(url);", "axios.get(url, { timeout: 5000 });"],
    ["axios.post(url, data);", "axios.post(url, data, { timeout: 5000 });"],
    ["axios.put(url, data, {});", "axios.put(url, data, { timeout: 5000,});"],
    ['axios.request({ url: "/" });', 'axios.request({ timeout: 5000, url: "/" });'],
  ]) {
    const { root } = repo(t, source);
    const plan = planCodemod(root, [finding("outbound-no-timeout")]);
    assert.equal(plan.files[0]?.after, expected);
    checkPatch(root, renderDiff(plan), "src/app.js", expected);
  }
});

test("await is suggested only for standalone calls in the nearest async function", (t) => {
  for (const source of [
    "async function save() { db.user.create({}); }\n",
    "const save = async () => { db.user.create({}); };\n",
    "const obj = { async save() { db.user.create({}); } };\n",
  ]) {
    const { root, full } = repo(t, source);
    const plan = planCodemod(root, [finding("floating-promise")]);
    assert.equal(plan.patched, 1);
    assert.match(plan.files[0].after, /await db.user.create/);
    assert.equal(plan.files[0].edits[0].safe, false);
    assert.deepEqual(applyPlan(root, plan), []);
    assert.equal(fs.readFileSync(full, "utf8"), source);
    const syntax = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: plan.files[0].after, encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
    checkPatch(root, renderDiff(plan), "src/app.js", plan.files[0].after);
  }
  for (const source of [
    "function save() { db.user.create({}); }", "db.user.create({});",
    "async function save() { function inner() { db.user.create({}); } }",
    "async function save() { (() => { db.user.create({}); })(); }",
    "async function save() { return db.user.create({}); }",
    "async function save() { const x = db.user.create({}); }",
    "async function save() { await db.user.create({}); }",
    "async function save() { db.user.create({}); db.user.create({}); }",
    "async function save() { fetch(url); db.user.create({}); }",
    "async function save() { class Inner { static { db.user.create({}); } } }",
  ]) {
    const { root } = repo(t, source);
    manualOnly(planCodemod(root, [finding("floating-promise")]));
  }
});

test("pagination suggestions are never applied, even alongside a safe edit", (t) => {
  for (const source of ["db.user.findMany();\n", "db.user.findAll({ where });\n", "db.user.findMany();\n" + fetchSource]) {
    const { root, full } = repo(t, source);
    const findings = [finding("unbounded-read")];
    if (source.includes("fetch")) findings.push(finding("outbound-no-timeout", 2));
    const plan = planCodemod(root, findings);
    assert.equal(plan.patched, findings.length);
    assert.equal(plan.files[0].edits[0].safe, false);
    assert.match(renderDiff(plan), /(?:take|limit): 50/);
    assert.deepEqual(applyPlan(root, plan), []);
    assert.equal(fs.readFileSync(full, "utf8"), source);
    checkPatch(root, renderDiff(plan), "src/app.js", plan.files[0].after);
  }
  for (const source of ["db.user.findMany({ take: 10 });", "db.user.findMany({ ...options });", "db.user.findMany(options);", "db.user.findMany(); db.user.findMany();", "db.user.find(); db.user.findMany();", "client.query(sql); db.user.findMany();"]) {
    const { root } = repo(t, source);
    manualOnly(planCodemod(root, [finding("unbounded-read")]));
  }
});

test("raw SQL is manual regardless of dialect, templates, comments or statement count", (t) => {
  for (const source of [
    'db.$queryRaw("SELECT * FROM users;");',
    'db.raw("SELECT * FROM users; SELECT * FROM posts");',
    'db.raw("SELECT * FROM users -- comment");',
    'db.raw("SELECT TOP 10 * FROM users");',
    'db.$queryRaw(`SELECT * FROM ${table}`);',
    'db.$queryRaw`SELECT * FROM users`;',
    'db.raw("SELECT * FROM users");',
  ]) {
    const { root } = repo(t, source);
    manualOnly(planCodemod(root, [finding("unbounded-raw-query")]));
  }
});

test("repeated findings cannot create duplicate positional insertions", (t) => {
  const { root } = repo(t, fetchSource);
  const f = finding("outbound-no-timeout");
  const plan = planCodemod(root, [f, { ...f, message: "duplicate" }]);
  assert.equal(plan.patched, 1);
  assert.equal(plan.unpatched, 1);
  assert.equal(plan.manual.length, 1);
  assert.equal((plan.files[0].after.match(/AbortSignal.timeout/g) ?? []).length, 1);
});

test("invalid source is manual, including on the apply path", (t) => {
  const { root } = repo(t, fetchSource + "function broken( {\n");
  manualOnly(planCodemod(root, [finding("outbound-no-timeout")]));
  fs.writeFileSync(path.join(root, "src/app.js"), fetchSource);
  const plan = planCodemod(root, [finding("outbound-no-timeout")]);
  plan.files[0].after += "function broken( {";
  assert.deepEqual(applyPlan(root, plan), []);
});

test("planning rejects unsafe paths, symlink files/ancestors, missing and oversized files", (t) => {
  const { root, full } = repo(t, fetchSource);
  const external = repo(t, fetchSource);
  fs.symlinkSync(external.full, path.join(root, "linked.js"));
  fs.symlinkSync(path.dirname(external.full), path.join(root, "linked-dir"));
  fs.writeFileSync(path.join(root, "big.js"), " ".repeat(1_000_001));
  for (const file of ["../app.js", full, "linked.js", "linked-dir/app.js", "missing.js", "src", "big.js"]) {
    manualOnly(planCodemod(root, [finding("outbound-no-timeout", 1, file)]));
  }
});

test("apply refuses changed, oversized, deleted, hardlinked and symlink-replaced files", (t) => {
  for (const replacement of ["changed", "oversized", "deleted", "symlink", "ancestor", "hardlink"]) {
    const source = fetchSource;
    const { root, full } = repo(t, source);
    const external = repo(t, source);
    const plan = planCodemod(root, [finding("outbound-no-timeout")]);
    if (replacement === "changed") fs.writeFileSync(full, changedFetchSource);
    if (replacement === "oversized") fs.writeFileSync(full, " ".repeat(1_000_001));
    if (["deleted", "symlink", "hardlink"].includes(replacement)) fs.unlinkSync(full);
    if (replacement === "symlink") fs.symlinkSync(external.full, full);
    if (replacement === "hardlink") fs.linkSync(external.full, full);
    if (replacement === "ancestor") {
      fs.renameSync(path.join(root, "src"), path.join(root, "old-src"));
      fs.symlinkSync(path.dirname(external.full), path.join(root, "src"));
    }
    const before = replacement === "deleted" ? null : fs.readFileSync(full, "utf8");
    assert.deepEqual(applyPlan(root, plan), [], replacement);
    if (before !== null) assert.equal(fs.readFileSync(full, "utf8"), before);
    else assert.equal(fs.existsSync(full), false);
    assert.equal(fs.readFileSync(external.full, "utf8"), source);
  }
});

test("descriptor validation prevents truncation when content changes after preflight", (t) => {
  for (const mode of ["content", "symlink", "ancestor"]) {
    const { root, full } = repo(t, fetchSource);
    const external = repo(t, fetchSource);
    const plan = planCodemod(root, [finding("outbound-no-timeout")]);
    const originalOpen = fs.openSync;
    const writePath = fs.realpathSync(full);
    let raced = false;
    fs.openSync = function (file, flags, ...args) {
      if (!raced && file === writePath && typeof flags === "number" && (flags & fs.constants.O_RDWR)) {
        raced = true;
        if (mode === "content") fs.writeFileSync(full, changedFetchSource);
        if (mode === "symlink") {
          fs.unlinkSync(full);
          fs.symlinkSync(external.full, full);
        }
        if (mode === "ancestor") {
          fs.renameSync(path.join(root, "src"), path.join(root, "old-src"));
          fs.symlinkSync(path.dirname(external.full), path.join(root, "src"));
        }
      }
      return originalOpen.call(fs, file, flags, ...args);
    };
    syncBuiltinESMExports();
    try {
      assert.deepEqual(applyPlan(root, plan), []);
      assert.equal(raced, true);
    } finally {
      fs.openSync = originalOpen;
      syncBuiltinESMExports();
    }
    assert.equal(fs.readFileSync(full, "utf8"), mode === "content" ? changedFetchSource : fetchSource);
    assert.equal(fs.readFileSync(external.full, "utf8"), fetchSource);
  }
});

test("large changed regions use bounded diff work and git-applicable patches", { timeout: 15_000 }, (t) => {
  const before = Array.from({ length: 20_000 }, (_, i) => `old ${i}\n`).join("");
  const after = Array.from({ length: 20_000 }, (_, i) => `new ${i}\n`).join("");
  const { root } = repo(t, before);
  const diff = unifiedDiff("src/app.js", before, after);
  checkPatch(root, diff, "src/app.js", after);
});

test("large mostly-unchanged files retain compact patches", (t) => {
  const before = "// padding\n".repeat(50_000) + fetchSource;
  const { root } = repo(t, before);
  const plan = planCodemod(root, [finding("outbound-no-timeout", 50_001)]);
  assert.equal(plan.patched, 1);
  const diff = renderDiff(plan);
  assert.ok(diff.length < 1000);
  checkPatch(root, diff, "src/app.js", plan.files[0].after);
});

test("diff handles empty files, EOF newline changes, CRLF and quoted paths", (t) => {
  for (const [before, after] of [
    ["", "hello\n"], ["hello\n", ""], ["hello", "hello\n"], ["hello\n", "hello"],
    ["one\ntwo", "changed\ntwo"], ["one\ntwo\n", "changed\ntwo\n"],
    ["one\r\ntwo\r\n", "changed\r\ntwo\r\n"], ["", "hello"], ["hello", ""],
  ]) {
    const file = "src/space and\ttab.js";
    const { root } = repo(t, before, file);
    checkPatch(root, unifiedDiff(file, before, after), file, after);
  }
});
