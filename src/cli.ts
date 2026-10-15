#!/usr/bin/env node
import { runAudit } from "./runner.js";
import { renderMarkdown } from "./reportMarkdown.js";
import type { Severity } from "./types.js";

const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let source: string | undefined;
  let out: string | undefined;
  let verify = false;
  let format: "json" | "md" = "json";
  let failOn: Severity | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out" || a === "-o") {
      out = args[++i];
    } else if (a === "--verify" || a === "-v") {
      verify = true;
    } else if (a === "--format") {
      const next = args[++i];
      if (next === "md" || next === "markdown") format = "md";
      else if (next === "json") format = "json";
      else throw new Error(`unknown --format value: ${next}`);
    } else if (a === "--fail-on") {
      const next = args[++i] as Severity;
      if (!(next in SEVERITY_RANK)) throw new Error(`unknown --fail-on value: ${next}`);
      failOn = next;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (!a.startsWith("--")) {
      source = a;
    }
  }
  if (!source) {
    printHelp();
    process.exit(1);
  }
  return { source, out, verify, format, failOn };
}

function printHelp() {
  console.log(`scale-audit - static scale-readiness audit for Node/TS repos

Usage:
  scale-audit <repo-url-or-local-path> [options]

Options:
  -o, --out <file>       Write report to a file (default: stdout)
  --format <json|md>     Output format (default: json)
  --verify, -v           Experimental JEV check: apply auto-fixes to an isolated
                         copy, re-scan, and report validity percentages.
  --fail-on <severity>   Exit with code 2 when a finding at/above this severity
                         exists (critical|high|medium|low). Useful for CI.
  -h, --help             Show this help.
`);
}

async function main() {
  const { source, out, verify, format, failOn } = parseArgs(process.argv);
  try {
    const report = await runAudit(source, { verifyFixes: verify });
    const output = format === "md" ? renderMarkdown(report) : JSON.stringify(report, null, 2);

    if (out) {
      const fs = await import("node:fs/promises");
      await fs.writeFile(out, output, "utf8");
      console.error(`wrote ${out}`);
    } else {
      console.log(output);
    }

    if (failOn) {
      const threshold = SEVERITY_RANK[failOn];
      const hit = report.findings.some((f) => SEVERITY_RANK[f.severity] >= threshold);
      if (hit) {
        console.error(`scale-audit: findings at or above "${failOn}" severity -> failing`);
        process.exitCode = 2;
      }
    }
  } catch (err) {
    console.error("ERROR:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
