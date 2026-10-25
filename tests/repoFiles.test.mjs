import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises, { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_MAX_FILE_BYTES, MAX_SOURCE_BYTES, MAX_SCHEMA_BYTES, MAX_MANIFEST_BYTES,
  RepoInputBudget, readRepoFile, readRepoFileSync, walkRepo,
} from "../dist/repoFiles.js";
import { fingerprintRepo } from "../dist/fingerprint.js";
import { loadSchemaGroups, findProjectDir } from "../dist/prisma.js";
import { listSourceFiles, readFileSafe } from "../dist/detectors/common.js";
import { Workspace } from "../dist/workspace.js";
import { detectInProcessState } from "../dist/detectors/inProcessState.js";
import { detectLifecycle } from "../dist/detectors/lifecycle.js";
import { detectReliability } from "../dist/detectors/reliability.js";
import { runAudit } from "../dist/runner.js";

async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "scale-audit-repo-files-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "repo");
  const outside = path.join(temp, "outside");
  await mkdir(root);
  await mkdir(outside);
  return { temp, root, outside };
}

async function both(root, rel, expected, maxBytes) {
  assert.equal(readRepoFileSync(root, rel, maxBytes), expected, `sync: ${rel}`);
  assert.equal(await readRepoFile(root, rel, maxBytes), expected, `async: ${rel}`);
}

const model = (name) => `model ${name} {\n  id Int @id\n}\n`;

test("shared reads accept regular files, byte boundaries, empty files and root aliases", async (t) => {
  const { root, temp } = await fixture(t);
  await writeFile(path.join(root, "source.ts"), "éé");
  await writeFile(path.join(root, "empty"), "");
  await both(root, "source.ts", "éé", 4);
  await both(root, "source.ts", null, 3);
  await both(root, "empty", "", 0);
  await both(root, "missing", null);
  const alias = path.join(temp, "alias");
  await symlink(root, alias, "dir");
  await both(alias, "source.ts", "éé");
  assert.equal(await readFileSafe(alias, "source.ts"), "éé");
});

test("shared reads reject traversal, absolute paths and malformed relative paths", async (t) => {
  const { root, outside } = await fixture(t);
  await writeFile(path.join(outside, "secret"), "outside");
  await writeFile(path.join(root, "local"), "inside");
  await mkdir(path.join(root, "nested"));
  for (const rel of [
    "../outside/secret", "nested/../../outside/secret", "nested/../local", path.join(outside, "secret"),
    "C:\\outside\\secret", "C:/outside/secret", "C:secret", "\\\\server\\share", "nested\\local",
    "./local", "nested//local", "", ".", "local\0", "local/",
  ]) await both(root, rel, null);
  for (const cap of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) await both(root, "local", null, cap);
});

test("shared reads reject symlink files and every symlink parent, including internal links", async (t) => {
  const { root, outside } = await fixture(t);
  await writeFile(path.join(outside, "secret.ts"), "external");
  await mkdir(path.join(root, "real"));
  await writeFile(path.join(root, "real", "local.ts"), "internal");
  await symlink(path.join(outside, "secret.ts"), path.join(root, "external.ts"));
  await symlink(path.join(root, "real", "local.ts"), path.join(root, "internal.ts"));
  await symlink(outside, path.join(root, "linked"), "dir");
  await mkdir(path.join(root, "nested"));
  await symlink(outside, path.join(root, "nested", "linked"), "dir");
  await symlink(path.join(root, "real"), path.join(root, "internal-dir"), "dir");
  for (const rel of ["external.ts", "internal.ts", "linked/secret.ts", "nested/linked/secret.ts", "internal-dir/local.ts"]) {
    await both(root, rel, null);
    assert.equal(await readFileSafe(root, rel), null);
  }
  assert.deepEqual(await listSourceFiles(root), ["real/local.ts"]);
  assert.deepEqual((await Workspace.load(root)).units.map((u) => u.rel), ["real/local.ts"]);
});

test("shared reads reject oversized and nonregular files without opening a blocking FIFO", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "large"), Buffer.alloc(DEFAULT_MAX_FILE_BYTES + 1));
  await writeFile(path.join(root, "exact"), Buffer.alloc(DEFAULT_MAX_FILE_BYTES, 97));
  await both(root, "large", null);
  await both(root, "exact", "a".repeat(DEFAULT_MAX_FILE_BYTES));
  await both(root, "large", "\0".repeat(DEFAULT_MAX_FILE_BYTES + 1), DEFAULT_MAX_FILE_BYTES + 1);
  await both(root, "exact", null, 2);
  await mkdir(path.join(root, "directory"));
  await both(root, "directory", null);
  if (process.platform !== "win32") {
    execFileSync("mkfifo", [path.join(root, "pipe")]);
    await both(root, "pipe", null);
  }
});

test("sync reads stay bounded when a regular file grows after fstat", async (t) => {
  const { root } = await fixture(t);
  const file = path.join(root, "growing");
  await writeFile(file, "a");
  const original = fs.readSync;
  let requested = 0;
  let grew = false;
  fs.readSync = function (fd, buffer, offset, length, position) {
    requested += length;
    if (!grew) {
      grew = true;
      fs.appendFileSync(file, "b".repeat(100));
    }
    return original(fd, buffer, offset, length, position);
  };
  try {
    assert.equal(readRepoFileSync(root, "growing", 4), null);
    assert.ok(requested <= 5, `requested ${requested} bytes, expected at most cap + 1`);
  } finally {
    fs.readSync = original;
  }
});

test("fingerprinting ignores external symlink root and workspace manifests and symlink parents", async (t) => {
  const { root, outside } = await fixture(t);
  await writeFile(path.join(outside, "package.json"), JSON.stringify({ private: true, dependencies: { express: "*", prisma: "*" } }));
  await symlink(path.join(outside, "package.json"), path.join(root, "package.json"));
  await mkdir(path.join(root, "packages", "linked-file"), { recursive: true });
  await symlink(path.join(outside, "package.json"), path.join(root, "packages", "linked-file", "package.json"));
  await symlink(outside, path.join(root, "packages", "linked-parent"), "dir");
  const fp = await fingerprintRepo(root);
  assert.equal(fp.framework, null);
  assert.equal(fp.orm, null);
  assert.equal(fp.projectType, "unknown");
  assert.deepEqual(Object.keys(fp.deps), []);
  await mkdir(path.join(root, "packages", "local"));
  await writeFile(path.join(root, "packages", "local", "package.json"), JSON.stringify({ dependencies: { fastify: "*" } }));
  assert.equal((await fingerprintRepo(root)).framework, "Fastify");
});

test("Prisma ignores external schema links, parent links and unsafe project manifests", async (t) => {
  const { root, outside } = await fixture(t);
  await writeFile(path.join(outside, "schema.prisma"), model("External"));
  await writeFile(path.join(outside, "package.json"), "{}");
  await symlink(path.join(outside, "schema.prisma"), path.join(root, "schema.prisma"));
  await mkdir(path.join(root, "packages", "local"), { recursive: true });
  await symlink(outside, path.join(root, "packages", "linked"), "dir");
  await symlink(path.join(outside, "package.json"), path.join(root, "packages", "local", "package.json"));
  await writeFile(path.join(root, "packages", "local", "schema.prisma"), model("Local"));
  let groups = await loadSchemaGroups(root);
  assert.deepEqual([...groups.global.keys()], ["local"]);
  assert.deepEqual([...groups.byProject.keys()], [""]);
  assert.equal(await findProjectDir(root, "packages/local", new Map()), null);
  assert.equal(await findProjectDir(root, "packages/linked", new Map()), null);
  for (const dir of ["../outside", "/", "../../", "C:/outside"]) {
    assert.equal(await findProjectDir(root, dir, new Map()), null);
  }
  await rm(path.join(root, "packages", "local", "package.json"));
  await writeFile(path.join(root, "packages", "local", "package.json"), "{}");
  groups = await loadSchemaGroups(root);
  assert.deepEqual([...groups.byProject.keys()], ["packages/local"]);
});

test("oversized/nonregular metadata and schemas are ignored consistently", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { express: "*" }, padding: " ".repeat(DEFAULT_MAX_FILE_BYTES) }));
  await writeFile(path.join(root, "large.prisma"), model("External") + " ".repeat(DEFAULT_MAX_FILE_BYTES));
  await mkdir(path.join(root, "packages", "dir", "package.json"), { recursive: true });
  await mkdir(path.join(root, "schema.prisma"));
  const fp = await fingerprintRepo(root);
  assert.equal(fp.framework, null);
  assert.equal((await loadSchemaGroups(root)).global.size, 0);
  assert.equal(await findProjectDir(root, "packages/dir", new Map()), null);
});

test("invalid manifest values and dependency shapes do not crash or contribute dependencies", async (t) => {
  const { root } = await fixture(t);
  await mkdir(path.join(root, "packages", "child"), { recursive: true });
  for (const value of [null, [], "express", 7, true, { dependencies: null }, { dependencies: ["express"] }, { dependencies: "express", devDependencies: "prisma" }, { dependencies: { express: 42 }, devDependencies: [] }]) {
    const text = JSON.stringify(value);
    await writeFile(path.join(root, "package.json"), text);
    await writeFile(path.join(root, "packages", "child", "package.json"), text);
    const fp = await fingerprintRepo(root);
    assert.equal(fp.framework, null, text);
    assert.equal(fp.orm, null, text);
    assert.equal(fp.projectType, "unknown", text);
    assert.deepEqual(Object.keys(fp.deps), [], text);
    assert.deepEqual(Object.keys(fp.devDeps), [], text);
  }
  await writeFile(path.join(root, "package.json"), "{not json");
  assert.equal((await fingerprintRepo(root)).projectType, "unknown");
});

test("safe ordinary manifests retain framework, ORM and project classification", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { express: "1" }, devDependencies: { prisma: "2", vitest: "3" } }));
  const fp = await fingerprintRepo(root);
  assert.equal(fp.framework, "Express");
  assert.equal(fp.orm, "Prisma");
  assert.equal(fp.projectType, "application");
  assert.equal(fp.hasTests, true);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ main: "index.js", devDependencies: { express: "1" } }));
  assert.equal((await fingerprintRepo(root)).projectType, "library");
});

test("symlink CI metadata and test directories do not count as repository metadata", async (t) => {
  const { root, outside } = await fixture(t);
  await mkdir(path.join(outside, "workflows"));
  await writeFile(path.join(outside, "ci.yml"), "external");
  await symlink(outside, path.join(root, ".github"), "dir");
  await symlink(path.join(outside, "ci.yml"), path.join(root, ".gitlab-ci.yml"));
  await symlink(outside, path.join(root, "tests"), "dir");
  let fp = await fingerprintRepo(root);
  assert.equal(fp.hasCI, false);
  assert.equal(fp.hasTests, false);
  await rm(path.join(root, ".github"));
  await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  fp = await fingerprintRepo(root);
  assert.equal(fp.hasCI, true);
});

test("streaming traversal enforces entry and depth caps instead of truncating", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "one"), "");
  await writeFile(path.join(root, "two"), "");
  const collect = async (options) => {
    const entries = [];
    for await (const entry of walkRepo(root, options)) entries.push(entry);
    return entries;
  };
  await assert.rejects(collect({ maxEntries: 1 }), /entry limit/);
  await mkdir(path.join(root, "a", "b"), { recursive: true });
  await assert.rejects(collect({ maxDepth: 1 }), /depth limit/);
  assert.equal((await collect({})).length, 4);
});

test("aggregate input budgets measure bytes and explicitly reject overflow", () => {
  const budget = new RepoInputBudget("test", 4);
  budget.add("éé");
  assert.throws(() => budget.add("x"), /test input exceeds aggregate limit of 4 bytes/);
});

test("fingerprinting rejects aggregate manifest inputs over the cap", async (t) => {
  const { root } = await fixture(t);
  const manifest = JSON.stringify({ padding: " ".repeat(900_000) });
  const count = Math.floor(MAX_MANIFEST_BYTES / Buffer.byteLength(manifest)) + 1;
  for (let i = 0; i < count; i++) {
    const dir = i === 0 ? root : path.join(root, `package-${i}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), manifest);
  }
  await assert.rejects(fingerprintRepo(root), /manifest input exceeds aggregate limit/);
});

test("Prisma rejects aggregate schema inputs over the cap", async (t) => {
  const { root } = await fixture(t);
  const schema = "//" + " ".repeat(900_000) + "\n" + model("Local");
  const count = Math.floor(MAX_SCHEMA_BYTES / Buffer.byteLength(schema)) + 1;
  for (let i = 0; i < count; i++) await writeFile(path.join(root, `schema-${i}.prisma`), schema);
  await assert.rejects(loadSchemaGroups(root), /schema input exceeds aggregate limit/);
});

test("Workspace rejects aggregate source inputs over the cap", async (t) => {
  const { root } = await fixture(t);
  const source = "//" + " ".repeat(900_000) + "\nexport {};\n";
  const count = Math.floor(MAX_SOURCE_BYTES / Buffer.byteLength(source)) + 1;
  for (let i = 0; i < count; i++) await writeFile(path.join(root, `source-${i}.ts`), source);
  await assert.rejects(Workspace.load(root), /source input exceeds aggregate limit/);
});

const detectorManifest = {
  dependencies: { express: "*", "@socket.io/redis-adapter": "*", "p-retry": "*" },
};
const detectorSource = `import { Server } from "socket.io";
const io = new Server();
app.listen(3000);
export async function callService() {
  return await fetch("https://example.invalid");
}
`;
const manifestDetectors = [detectInProcessState, detectLifecycle, detectReliability];
const detectorFindings = (root, workspace) => Promise.all(manifestDetectors.map((detect) => detect(root, workspace)));

function assertManifestIgnored(findings) {
  const ids = findings.map((finding) => finding.id);
  assert.ok(ids.includes("in-memory-websocket"), "external adapter must not suppress WebSocket finding");
  assert.ok(ids.includes("no-retry-strategy"), "external retry package must not suppress retry finding");
  assert.ok(!ids.includes("missing-health-endpoint"), "external framework must not introduce health finding");
}

test("runAudit detector output is unaffected by an external root manifest symlink", async (t) => {
  const { root, outside } = await fixture(t);
  await writeFile(path.join(root, "server.ts"), detectorSource);
  const baseline = await runAudit(root);
  assertManifestIgnored(baseline.findings);
  const externalManifest = path.join(outside, "package.json");
  await writeFile(externalManifest, JSON.stringify(detectorManifest));
  await symlink(externalManifest, path.join(root, "package.json"));
  const linked = await runAudit(root);
  assert.deepEqual(linked.findings, baseline.findings);
  assert.deepEqual(linked.score, baseline.score);
  assertManifestIgnored(linked.findings);

  // The same dependencies must still affect detectors when owned by the repo.
  await rm(path.join(root, "package.json"));
  await writeFile(path.join(root, "package.json"), JSON.stringify(detectorManifest));
  const local = await runAudit(root);
  const ids = local.findings.map((finding) => finding.id);
  assert.ok(!ids.includes("in-memory-websocket"));
  assert.ok(!ids.includes("no-retry-strategy"));
  assert.ok(ids.includes("missing-health-endpoint"));
});

test("manifest-reading detectors tolerate invalid root and dependency shapes", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "server.ts"), detectorSource);
  const workspace = await Workspace.load(root);
  const baseline = await detectorFindings(root, workspace);
  assertManifestIgnored(baseline.flat());
  for (const value of [
    null, [], "express", 7, true,
    { dependencies: null, devDependencies: null },
    { dependencies: ["express", "p-retry"], devDependencies: ["@socket.io/redis-adapter"] },
    { dependencies: "express", devDependencies: "p-retry" },
    { dependencies: false, devDependencies: 42 },
  ]) {
    await writeFile(path.join(root, "package.json"), JSON.stringify(value));
    assert.deepEqual(await detectorFindings(root, workspace), baseline, JSON.stringify(value));
  }
  await writeFile(path.join(root, "package.json"), "{not json");
  assert.deepEqual(await detectorFindings(root, workspace), baseline);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ devDependencies: detectorManifest.dependencies }));
  const validDevDeps = (await detectorFindings(root, workspace)).flat().map((finding) => finding.id);
  assert.ok(!validDevDeps.includes("in-memory-websocket"));
  assert.ok(!validDevDeps.includes("no-retry-strategy"));
  assert.ok(validDevDeps.includes("missing-health-endpoint"));
});

for (const kind of ["oversized", "FIFO"]) {
  test(`detectors and runAudit do not open ${kind} root manifests`, { skip: kind === "FIFO" && process.platform === "win32" }, async (t) => {
    const { root } = await fixture(t);
    await writeFile(path.join(root, "server.ts"), detectorSource);
    const workspace = await Workspace.load(root);
    const baseline = await detectorFindings(root, workspace);
    const baselineAudit = await runAudit(root);
    const manifestPath = path.join(root, "package.json");
    if (kind === "FIFO") execFileSync("mkfifo", [manifestPath]);
    else await writeFile(manifestPath, JSON.stringify({ ...detectorManifest, padding: " ".repeat(DEFAULT_MAX_FILE_BYTES) }));

    const attempts = [];
    const manifestPaths = new Set([manifestPath, path.join(fs.realpathSync(root), "package.json")]);
    // Guard both the shared descriptor API and the old unbounded read API.
    // Throwing on an attempted FIFO read also prevents a regressed test hanging.
    for (const [api, method] of [[fsPromises, "open"], [fsPromises, "readFile"], [fs, "openSync"], [fs, "readFileSync"]]) {
      const original = api[method];
      t.mock.method(api, method, function (file, ...args) {
        if (typeof file === "string" && manifestPaths.has(path.resolve(file))) {
          attempts.push(method);
          throw new Error(`Unexpected ${method} of ${kind} manifest`);
        }
        return Reflect.apply(original, this, [file, ...args]);
      });
    }
    syncBuiltinESMExports();
    try {
      // Cover both standalone detector loading and the shared-workspace path.
      assert.deepEqual(await detectorFindings(root), baseline);
      assert.deepEqual(await detectorFindings(root, workspace), baseline);
      const report = await runAudit(root);
      assert.deepEqual(report.findings, baselineAudit.findings);
      assertManifestIgnored(report.findings);
      assert.deepEqual(attempts, [], `${kind} manifests must be rejected before open/readFile`);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
}
