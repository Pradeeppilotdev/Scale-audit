import type { Report } from "./types.js";

export function renderHtml(report: Report): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const shown = report.findings.slice(0, 100);
  const findings = shown
    .map(
      (f) => `<div class="finding sev-${f.severity}">
        <div class="badge">${esc(f.severity)}${f.confidence === "low" ? " (low confidence)" : ""}</div>
        <div class="msg">${esc(f.message)}</div>
        <div class="loc">${esc(f.file)}:${f.line} <span class="cat">${esc(f.category)}</span></div>
        <div class="why"><b>Why it breaks:</b> ${esc(f.scaleTrigger)}</div>
        <div class="fix"><b>Fix:</b> ${esc(f.suggestedFix)}</div>
      </div>`,
    )
    .join("\n");

  const categories = (report.summary?.categories ?? [])
    .map((c) => `<tr><td>${esc(c.category)}</td><td>${c.score}/100</td><td>${c.findings}</td></tr>`)
    .join("");

  const codemod = (report.codemod?.edits ?? [])
    .map((e) => `<li>${esc(e.file)}:${e.line} — ${esc(e.description)}</li>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Scale-Readiness — ${esc(report.repo)}</title>
<style>
  :root { --bg:#0b0f17; --panel:#121826; --text:#e6edf3; --muted:#8b949e; --line:#253041; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 32px 20px 80px; }
  h1 { font-size:22px; margin:0 0 4px; }
  .muted { color:var(--muted); font-size:13px; word-break:break-all; }
  .score { font-size:44px; font-weight:700; margin:24px 0 4px; }
  .verdict { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; margin:16px 0 28px; }
  .finding { background:var(--panel); border:1px solid var(--line); border-left:4px solid var(--muted); border-radius:10px; padding:14px 16px; margin:12px 0; }
  .sev-critical { border-left-color:#f85149; } .sev-high { border-left-color:#f0883e; }
  .sev-medium { border-left-color:#d29922; } .sev-low { border-left-color:#3fb950; } .sev-info { border-left-color:#58a6ff; }
  .badge { display:inline-block; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
  .msg { font-weight:600; margin:2px 0 6px; }
  .loc { color:var(--muted); font:12px ui-monospace,SFMono-Regular,Menlo,monospace; }
  .cat { margin-left:8px; }
  .why, .fix { font-size:13px; color:var(--muted); margin-top:6px; }
  .why b, .fix b { color:var(--text); }
  table.cats { border-collapse:collapse; margin:12px 0 28px; }
  table.cats th, table.cats td { text-align:left; padding:6px 18px 6px 0; border-bottom:1px solid var(--line); font-size:13px; }
  a { color:#58a6ff; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Scale-Readiness Report</h1>
  <div class="muted">${esc(report.repo)}${report.commit ? ` @ ${esc(report.commit.slice(0, 12))}` : ""}</div>
  <div class="score">${report.score}/100</div>
  <div class="muted">Scanned ${esc(report.scannedAt)} · ${report.fingerprint.sourceFileCount} source files · ${esc(report.fingerprint.framework ?? "unknown framework")}${report.fingerprint.projectType !== "unknown" ? ` · ${esc(report.fingerprint.projectType)}` : ""}</div>
  ${
    report.firstBottleneck
      ? `<div class="verdict"><b>First bottleneck: ${esc(report.firstBottleneck.category)}</b><br/>${esc(report.firstBottleneck.message)}<br/><span class="muted">${esc(report.firstBottleneck.file)}:${report.firstBottleneck.line} — ${esc(report.firstBottleneck.scaleTrigger)}</span></div>`
      : `<div class="verdict">No blocking issues detected by the current detector set.</div>`
  }
  ${
    report.fingerprint.projectType === "library"
      ? `<div class="verdict"><b>This looks like a library, not an application.</b><br/><span class="muted">The score reflects the code's own query and I/O patterns rather than how a deployed service behaves.</span></div>`
      : ""
  }
  ${categories ? `<h2>Score by category</h2><table class="cats"><tr><th>Category</th><th>Score</th><th>Findings</th></tr>${categories}</table>` : ""}
  <h2>Findings (${report.findings.length})</h2>
  ${findings || "<p class='muted'>No findings.</p>"}
  ${report.findings.length > shown.length ? `<p class="muted">Showing the first ${shown.length} of ${report.findings.length} findings. Use the JSON output for the full list.</p>` : ""}
  ${codemod ? `<h2>Automated fixes (${report.codemod?.patched})</h2><ul>${codemod}</ul>` : ""}
  ${report.notes.length ? `<h2>Notes</h2><ul>${report.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
  <h2>What we could not verify</h2>
  <ul class="muted">
    <li>Actual DB size/query plans; no DB access.</li>
    <li>Real traffic concurrency and external service latency.</li>
    <li>Runtime infra limits outside the repo.</li>
  </ul>
  <p class="muted">Static analysis only. Target code was never executed.</p>
</div>
</body>
</html>`;
}
