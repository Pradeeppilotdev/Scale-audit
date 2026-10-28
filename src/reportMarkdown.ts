import type { Finding, Report } from "./types.js";

/** How many findings to list per category before collapsing into a count. */
const MAX_PER_CATEGORY = 10;

export function renderMarkdown(report: Report): string {
  const lines: string[] = [];
  lines.push(`# Scale-Readiness Report`);
  lines.push("");
  lines.push(`- Repo: \`${report.repo}\``);
  if (report.commit) lines.push(`- Commit: \`${report.commit.slice(0, 12)}\``);
  if (report.analyzer) lines.push(`- Analyzer: ${report.analyzer.name}@${report.analyzer.version} (report schema ${report.schemaVersion ?? "unknown"})`);
  lines.push(`- Scanned: ${report.scannedAt}`);
  lines.push(`- Framework: ${report.fingerprint.framework ?? "unknown"}`);
  lines.push(`- ORM: ${report.fingerprint.orm ?? "unknown"}`);
  lines.push(`- Source files: ${report.fingerprint.sourceFileCount}`);
  if (report.fingerprint.projectType !== "unknown") {
    lines.push(`- Project type: ${report.fingerprint.projectType}`);
  }
  lines.push("");
  lines.push(`## Verdict`);
  lines.push("");
  if (report.complete === false) lines.push("> **Incomplete audit.** Checks failed or source files were skipped. The score reflects successful checks only; it is not a clean bill of health.", "");
  lines.push(`**Scale score: ${report.score}/100**`);
  if (report.coverage) {
    const c = report.coverage;
    lines.push("", `Source coverage: ${c.analyzed}/${c.discovered} analyzed; ${c.skipped.length} skipped.`);
    if (c.skipped.length || c.analyzed === 0) lines.push("", "> Incomplete source coverage. This score applies only to analyzed files.");
    for (const skip of c.skipped) lines.push(`- Skipped ${JSON.stringify(skip.file)}: ${skip.reason}`);
  }
  if (report.analysisScope) {
    lines.push("", "### Analysis scope", "", report.analysisScope.purpose);
    for (const limitation of report.analysisScope.limitations) lines.push(`- ${limitation}`);
  }
  if (report.fingerprint.projectType === "library") {
    lines.push("");
    lines.push(
      "> This looks like a **library**, not an application. The score reflects the code's own query and I/O patterns rather than how a deployed service behaves.",
    );
  }
  if (report.firstBottleneck) {
    lines.push("");
    lines.push(
      `First bottleneck: **${report.firstBottleneck.category}** — ${report.firstBottleneck.message}`,
    );
    lines.push(`- Evidence: \`${report.firstBottleneck.file}:${report.firstBottleneck.line}\``);
    lines.push(`- Why: ${report.firstBottleneck.scaleTrigger}`);
    lines.push(`- Fix: ${report.firstBottleneck.suggestedFix}`);
  } else {
    lines.push("");
    lines.push("No blocking issues detected by the current detector set.");
  }

  if (report.summary?.categories.length) {
    lines.push("");
    lines.push(`## Score by category`);
    lines.push("");
    lines.push(`| Category | Score | Findings |`);
    lines.push(`| --- | --- | --- |`);
    for (const c of report.summary.categories) {
      lines.push(`| ${c.category} | ${c.score}/100 | ${c.findings} |`);
    }
  }

  const top = report.findings.slice(0, 5);
  lines.push("");
  lines.push(`## Top findings (${top.length} of ${report.findings.length})`);
  lines.push("");
  for (const [i, f] of top.entries()) {
    lines.push(`${i + 1}. **[${f.severity}] ${f.message}**`);
    lines.push(`   - Location: \`${f.file}:${f.line}\``);
    lines.push(`   - Why it breaks: ${f.scaleTrigger}`);
    lines.push(`   - Fix: ${f.suggestedFix}`);
    if (f.snippet) lines.push(`   - Snippet: \`${oneLine(f.snippet).slice(0, 160)}\``);
  }

  const byCategory = group(report.findings);
  lines.push("");
  lines.push(`## All findings by category`);
  for (const [category, items] of byCategory) {
    lines.push("");
    lines.push(`### ${category} (${items.length})`);
    lines.push("");
    for (const f of items.slice(0, MAX_PER_CATEGORY)) {
      lines.push(`- [${f.severity}] ${f.message} (\`${f.file}:${f.line}\`)`);
    }
    if (items.length > MAX_PER_CATEGORY) {
      lines.push(`- …and ${items.length - MAX_PER_CATEGORY} more in this category (use the JSON output for the full list).`);
    }
  }

  if (report.codemod) {
    const cm = report.codemod;
    lines.push(`## Automated fixes`);
    lines.push("");
    lines.push(`- ${cm.patched} suggestion(s) generated; ${cm.appliedEdits ?? 0} edit(s) applied; ${cm.unpatched} site(s) have no generated patch.`);
    for (const e of cm.edits.slice(0, MAX_PER_CATEGORY)) {
      lines.push(`- \`${e.file}:${e.line}\` — ${e.description}${e.safe ? "" : " (review required; never auto-applied)"}`);
    }
    for (const e of (cm.manual ?? []).slice(0, MAX_PER_CATEGORY)) {
      lines.push(`- Manual: \`${e.file}:${e.line}\` — ${e.description}`);
    }
    if (cm.diff) {
      lines.push("");
      lines.push("```diff");
      lines.push(cm.diff.trimEnd());
      lines.push("```");
    }
    lines.push("");
  }

  if (report.notes.length) {
    lines.push(`## Notes`);
    lines.push("");
    for (const n of report.notes) lines.push(`- ${n}`);
    lines.push("");
  }

  lines.push(`## What we could not verify`);
  lines.push("");
  lines.push("- Actual DB size/query plans; no DB access.");
  lines.push("- Real traffic concurrency and external service latency.");
  lines.push("- Runtime infra limits (CPU/memory/replicas) outside the repo.");
  lines.push("");
  lines.push(`_Static analysis only. Target code was never executed._`);
  lines.push("");

  return lines.join("\n");
}

function group(findings: Finding[]): Map<string, Finding[]> {
  const m = new Map<string, Finding[]>();
  for (const f of findings) {
    const arr = m.get(f.category) ?? [];
    arr.push(f);
    m.set(f.category, arr);
  }
  return m;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
