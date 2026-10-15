import type { Finding, Report } from "./types.js";

export function renderMarkdown(report: Report): string {
  const lines: string[] = [];
  lines.push(`# Scale-Readiness Report`);
  lines.push("");
  lines.push(`- Repo: \`${report.repo}\``);
  if (report.commit) lines.push(`- Commit: \`${report.commit.slice(0, 12)}\``);
  lines.push(`- Scanned: ${report.scannedAt}`);
  lines.push(`- Framework: ${report.fingerprint.framework ?? "unknown"}`);
  lines.push(`- ORM: ${report.fingerprint.orm ?? "unknown"}`);
  lines.push(`- Source files: ${report.fingerprint.sourceFileCount}`);
  lines.push("");
  lines.push(`## Verdict`);
  lines.push("");
  lines.push(`**Scale score: ${report.score}/100**`);
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

  const top = report.findings.slice(0, 5);
  lines.push("");
  lines.push(`## Top findings (${top.length})`);
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
  lines.push("");
  for (const [category, items] of byCategory) {
    lines.push(`### ${category} (${items.length})`);
    lines.push("");
    for (const f of items) {
      lines.push(`- [${f.severity}] ${f.message} (\`${f.file}:${f.line}\`)`);
    }
    lines.push("");
  }

  if (report.verification?.length) {
    lines.push(`## Experimental fix verification (JEV)`);
    lines.push("");
    for (const v of report.verification) {
      const validity = v.validity === null ? "n/a" : `${v.validity}%`;
      lines.push(`- ${v.findingId} at \`${v.file}:${v.line}\`: ${validity} (${v.method})`);
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
