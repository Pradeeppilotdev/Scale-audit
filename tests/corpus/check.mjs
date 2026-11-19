import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { runAudit } from "../../dist/runner.js";

const usage = "Usage: npm run test:corpus -- [--print] nanpolis=/path/to/nanpolis hono=/path/to/hono";

export function snapshot(report) {
  if (!report.complete || !report.coverage || !report.coverage.analyzed ||
      report.coverage.analyzed !== report.coverage.discovered || report.coverage.skipped.length ||
      !report.detectors?.length ||
      report.detectors.some(detector => detector.status !== "complete")) {
    const failures = report.detectors?.filter(detector => detector.status !== "complete") ?? [];
    const detail = failures.map(detector => `${detector.name} (${detector.reason})`).join(", ");
    throw new Error(`Audit incomplete${detail ? ` — ${detail}` : ""}; coverage ${JSON.stringify(report.coverage)}`);
  }

  const findings = report.findings.map(finding =>
    JSON.stringify([finding.id, finding.file, finding.line, finding.severity, finding.confidence]));
  return {
    score: report.score,
    discovered: report.coverage.discovered,
    analyzed: report.coverage.analyzed,
    skipped: report.coverage.skipped.length,
    detectors: report.detectors.map(detector => detector.name).sort(),
    findings: findings.sort().map(row => JSON.parse(row)),
  };
}

export function changes(expected, actual) {
  const result = [];
  for (const field of ["score", "discovered", "analyzed", "skipped"]) {
    if (expected[field] !== actual[field]) {
      result.push(`${field}: expected ${expected[field]}, got ${actual[field]}`);
    }
  }
  const detectors = new Set(actual.detectors);
  for (const name of expected.detectors) {
    if (!detectors.has(name)) result.push(`Detector missing: ${name}`);
  }

  const counts = new Map();
  for (const [findings, direction] of [[expected.findings, -1], [actual.findings, 1]]) {
    for (const finding of findings) {
      const row = JSON.stringify(finding);
      counts.set(row, (counts.get(row) ?? 0) + direction);
    }
  }
  for (const [finding, count] of counts) {
    for (let index = 0; index < Math.abs(count); index++) {
      result.push(`${count < 0 ? "-" : "+"} ${finding}`);
    }
  }
  return result;
}

export async function withRevision(checkout, commit, run) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error("Corpus pin must be a full commit hash");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  Object.assign(env, {
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
  });
  const git = (args, options) => execFileSync("git", args, { env, stdio: ["ignore", "pipe", "pipe"], ...options });
  const location = ["-C", resolve(checkout)];
  const objects = git([...location, "rev-parse", "--path-format=absolute", "--git-path", "objects"], { encoding: "utf8" }).replace(/\r?\n$/, "");
  const format = git([...location, "rev-parse", "--show-object-format"], { encoding: "utf8" }).trim();
  if (format !== "sha1" && format !== "sha256") throw new Error(`Unsupported Git object format: ${format}`);
  if (commit.length !== (format === "sha1" ? 40 : 64)) throw new Error("Corpus pin must be a full commit hash");
  const temporary = await mkdtemp(join(tmpdir(), "scale-corpus-"));
  try {
    const archive = join(temporary, "source.tar");
    const source = join(temporary, "source");
    const isolated = join(temporary, "git");
    await mkdir(source);
    // Read the checkout's objects without inheriting its refs, configuration or attributes.
    git(["init", "--quiet", "--bare", "--template=", `--object-format=${format}`, isolated]);
    const objectEnv = { ...env, GIT_OBJECT_DIRECTORY: objects };
    const objectGit = ["--git-dir", isolated];
    if (git([...objectGit, "cat-file", "-t", commit], { env: objectEnv, encoding: "utf8" }).trim() !== "commit") {
      throw new Error("Corpus pin must refer to a commit");
    }
    // Keep export-ignore, but prevent archive metadata from changing source bytes.
    await mkdir(join(isolated, "info"), { recursive: true });
    await writeFile(join(isolated, "info", "attributes"), "* -export-subst\n");
    git([...objectGit, "-c", `core.attributesFile=${devNull}`, "archive", "--format=tar", `--output=${archive}`, commit],
      { env: objectEnv });
    execFileSync("tar", ["-xf", archive, "-C", source], { stdio: ["ignore", "ignore", "pipe"] });
    return await run(source);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main(args) {
  const baseline = JSON.parse(await readFile(new URL("./baseline.json", import.meta.url), "utf8"));
  const print = args[0] === "--print";
  const selected = new Map();
  for (const argument of print ? args.slice(1) : args) {
    const separator = argument.indexOf("=");
    const name = argument.slice(0, separator);
    const checkout = argument.slice(separator + 1);
    if (separator < 1 || !checkout || !Object.hasOwn(baseline, name) || selected.has(name)) {
      throw new Error(`Invalid corpus selection: ${argument}\n${usage}`);
    }
    selected.set(name, checkout);
  }
  if (!selected.size) throw new Error(usage);

  let failed = false;
  const observed = {};
  for (const [name, checkout] of selected) {
    const { commit, expected } = baseline[name];
    try {
      const { report, elapsed } = await withRevision(checkout, commit, async source => {
        const started = performance.now();
        const report = await runAudit(source);
        return { report, elapsed: Math.round(performance.now() - started) };
      });
      const actual = snapshot(report);
      if (print) {
        observed[name] = { commit, expected: actual };
        continue;
      }
      const differences = changes(expected, actual);
      const status = differences.length ? "changed" : "matches";
      console.log(`${name} ${commit.slice(0, 12)} ${status} · ${actual.score}/100 · ${actual.analyzed}/${actual.discovered} files · ${actual.findings.length} findings · ${elapsed} ms`);
      if (differences.length) {
        failed = true;
        for (const difference of differences) console.error(`  ${difference}`);
      }
    } catch (error) {
      failed = true;
      console.error(`${name} ${commit}: ${error.message}`);
    }
  }
  if (print && !failed) console.log(JSON.stringify(observed, null, 2));
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
