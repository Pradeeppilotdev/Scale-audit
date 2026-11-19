import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { changes, snapshot, withRevision } from "./corpus/check.mjs";

const report = {
  complete: true,
  score: 98,
  coverage: { analyzed: 2, discovered: 2, skipped: [] },
  detectors: [{ name: "detectSyncIo", status: "complete" }],
};
const finding = {
  id: "sync-io",
  file: "src/routes.ts",
  line: 12,
  severity: "high",
  confidence: "medium",
};

test("corpus snapshots normalize finding order and omit snippets and environment details", () => {
  const other = { ...finding, line: 3 };
  const actual = snapshot({
    ...report,
    repo: "/private/checkout",
    scannedAt: "ignored",
    findings: [other, { ...finding, snippet: "ignored" }],
  });
  assert.deepEqual(actual, snapshot({ ...report, findings: [finding, other] }));
  assert.deepEqual(actual.findings, [
    ["sync-io", "src/routes.ts", 12, "high", "medium"],
    ["sync-io", "src/routes.ts", 3, "high", "medium"],
  ]);
});

test("corpus comparison catches a missing detector with no findings and allows added checks", () => {
  const original = snapshot({ ...report, findings: [] });
  const expanded = snapshot({
    ...report,
    detectors: [{ name: "detectQueueBackpressure", status: "complete" }, ...report.detectors],
    findings: [],
  });
  assert.deepEqual(expanded.detectors, ["detectQueueBackpressure", "detectSyncIo"]);
  assert.deepEqual(changes(expanded, original), ["Detector missing: detectQueueBackpressure"]);
  assert.deepEqual(changes(original, expanded), []);
});

test("corpus comparison reports coverage, score, severity and duplicate finding changes", () => {
  const expected = snapshot({ ...report, findings: [finding, finding] });
  const actual = snapshot({
    ...report,
    score: 99,
    coverage: { analyzed: 1, discovered: 1, skipped: [] },
    findings: [finding, { ...finding, severity: "medium" }],
  });
  assert.deepEqual(changes(expected, actual), [
    "score: expected 98, got 99",
    "discovered: expected 2, got 1",
    "analyzed: expected 2, got 1",
    '- ["sync-io","src/routes.ts",12,"high","medium"]',
    '+ ["sync-io","src/routes.ts",12,"medium","medium"]',
  ]);
});

test("corpus snapshots reject incomplete audits before comparing findings", () => {
  assert.throws(() => snapshot({
    ...report,
    complete: false,
    detectors: [{ name: "detectSyncIo", status: "failed", reason: "Work limit exceeded" }],
  }), /Audit incomplete.*detectSyncIo \(Work limit exceeded\)/);
  assert.throws(() => snapshot({
    ...report,
    coverage: { analyzed: 1, discovered: 2, skipped: [{ file: "large.ts", reason: "size" }] },
  }), /Audit incomplete.*coverage/);
});

test("corpus runs on the pinned tree and cleans up after success and failure", async t => {
  const checkout = await mkdtemp(join(tmpdir(), "scale-corpus-test-"));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet");
  const path = join(checkout, "source.ts");
  await writeFile(path, "export const revision = 'pinned';\n");
  git("add", "source.ts");
  const commit = git("-c", "user.name=Corpus", "-c", "user.email=corpus@example.invalid",
    "commit-tree", git("write-tree"), "-m", "Pinned source");
  await writeFile(path, "export const revision = 'working';\n");
  await writeFile(join(checkout, "untracked.ts"), "");

  let archived;
  const check = async source => {
    archived = source;
    assert.equal(await readFile(join(source, "source.ts"), "utf8"), "export const revision = 'pinned';\n");
    await assert.rejects(readFile(join(source, "untracked.ts")), { code: "ENOENT" });
    return 42;
  };
  assert.equal(await withRevision(checkout, commit, check), 42);
  await assert.rejects(readFile(join(dirname(archived), "source.tar")), { code: "ENOENT" });
  await assert.rejects(withRevision(checkout, commit, async source => {
    await check(source);
    throw new Error("failed callback");
  }), /failed callback/);
  await assert.rejects(readFile(join(archived, "source.ts")), { code: "ENOENT" });
  assert.equal(await readFile(path, "utf8"), "export const revision = 'working';\n");
});

test("corpus pins ignore replacement refs and checkout-specific archive attributes", async t => {
  const checkout = await mkdtemp(join(tmpdir(), "scale-corpus-metadata-"));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  const commit = message => git("-c", "user.name=Corpus", "-c", "user.email=corpus@example.invalid",
    "commit-tree", git("write-tree"), "-m", message);
  git("init", "--quiet", "--template=");
  await writeFile(join(checkout, "source.ts"), "export const revision = 'pinned';\n");
  await writeFile(join(checkout, "extra.ts"), "export const extra = true;\n");
  await writeFile(join(checkout, "ignored.ts"), "export {};\n");
  await writeFile(join(checkout, ".gitattributes"), "ignored.ts export-ignore\n");
  git("add", ".");
  const pinned = commit("Pinned source");
  await writeFile(join(checkout, "source.ts"), "export const revision = 'substitute';\n");
  git("add", "source.ts");
  git("replace", pinned, commit("Substitute source"));
  await mkdir(join(checkout, ".git", "info"), { recursive: true });
  await writeFile(join(checkout, ".git", "info", "attributes"), "source.ts export-ignore\n");
  const localAttributes = join(checkout, "attrs");
  await writeFile(localAttributes, "extra.ts export-ignore\n");
  git("config", "core.attributesFile", localAttributes);

  await withRevision(checkout, pinned, async source => {
    assert.equal(await readFile(join(source, "source.ts"), "utf8"), "export const revision = 'pinned';\n");
    assert.equal(await readFile(join(source, "extra.ts"), "utf8"), "export const extra = true;\n");
    await assert.rejects(readFile(join(source, "ignored.ts"), "utf8"), { code: "ENOENT" });
  });

  const script = `
    import assert from "node:assert/strict";
    import { readFile } from "node:fs/promises";
    import { join } from "node:path";
    import { withRevision } from ${JSON.stringify(new URL("./corpus/check.mjs", import.meta.url).href)};
    await withRevision(process.argv[1], process.argv[2], async source => {
      assert.equal(await readFile(join(source, "source.ts"), "utf8"), "export const revision = 'pinned';\\n");
      assert.equal(await readFile(join(source, "extra.ts"), "utf8"), "export const extra = true;\\n");
    });
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script, checkout, pinned], {
    env: {
      ...process.env,
      GIT_DIR: join(checkout, "wrong-git-dir"),
      GIT_REPLACE_REF_BASE: "refs/replace/",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.attributesFile",
      GIT_CONFIG_VALUE_0: localAttributes,
    },
  });
});

test("corpus archives preserve committed bytes when files opt into Git substitutions", async t => {
  const checkout = await mkdtemp(join(tmpdir(), "scale-corpus-substitutions-"));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet", "--template=");
  await mkdir(join(checkout, "src"));
  await writeFile(join(checkout, ".gitattributes"), "source.ts export-subst\n");
  await writeFile(join(checkout, "src", ".gitattributes"), "*.ts export-subst\n");
  const content = 'export const format = "$Format:%ar$ $Format:%H$";\n';
  await writeFile(join(checkout, "source.ts"), content);
  await writeFile(join(checkout, "src", "nested.ts"), content);
  git("add", ".");
  const tree = git("write-tree");
  const commit = git("-c", "user.name=Corpus", "-c", "user.email=corpus@example.invalid",
    "commit-tree", tree, "-m", "Source with volatile archive attributes");
  await withRevision(checkout, commit, async source => {
    assert.equal(await readFile(join(source, "source.ts"), "utf8"), content);
    assert.equal(await readFile(join(source, "src", "nested.ts"), "utf8"), content);
  });
  await assert.rejects(withRevision(checkout, tree, () => assert.fail("archive opened for a tree pin")),
    /Corpus pin must refer to a commit/);
});
