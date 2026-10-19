#!/usr/bin/env node
import { runAudit } from "./runner.js";
import { renderMarkdown } from "./reportMarkdown.js";
import { isRemote } from "./clone.js";
import type { Severity } from "./types.js";

const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

interface Args {
  source: string;
  out?: string;
  format: "json" | "md";
  failOn?: Severity;
  codemod?: "diff" | "apply";
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let source: string | undefined;
  let out: string | undefined;
  let format: "json" | "md" = "json";
  let failOn: Severity | undefined;
  let codemod: "diff" | "apply" | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out" || a === "-o") {
      out = args[++i];
    } else if (a === "--fix") {
      codemod = "apply";
    } else if (a === "--diff") {
      codemod = "diff";
    } else if (a === "--verify" || a === "-v") {
      // Deprecated: the old JEV experiment. Kept as an alias for --diff.
      console.error("scale-audit: --verify is deprecated, use --diff (or --fix) instead.");
      codemod = codemod ?? "diff";
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
    } else if (!a.startsWith("-")) {
      source = a;
    }
  }
  if (!source) {
    printHelp();
    process.exit(1);
  }
  return { source, out, format, failOn, codemod };
}

function printHelp() {
  console.log(`scale-audit - static scale-readiness audit for Node/TS repos

Usage:
  scale-audit <repo-url-or-local-path> [options]

Options:
  -o, --out <file>       Write report to a file (default: stdout)
  --format <json|md>     Output format (default: json)
  --diff                 Print a unified diff with automated fixes for the findings
  --fix                  Apply automated fixes in place (local paths only)
  --fail-on <severity>   Exit with code 2 when a finding at/above this severity
                         exists (critical|high|medium|low). Useful for CI.
  -h, --help             Show this help.
`);
}

async function main() {
  const { source, out, format, failOn, codemod } = parseArgs(process.argv);
  try {
    if (codemod === "apply" && isRemote(source)) {
      console.error("scale-audit: --fix only works on a local path; a cloned repo is discarded after the audit.");
      process.exit(1);
    }

    const report = await runAudit(source, { codemod });
    const cm = report.codemod;

    if (codemod === "diff") {
      // stdout is the patch, so it can be piped straight into `git apply`.
      if (cm?.diff) process.stdout.write(cm.diff);
      else console.error("scale-audit: no automated fixes were generated for these findings.");
      if (out) {
        const fs = await import("node:fs/promises");
        await fs.writeFile(out, format === "md" ? renderMarkdown(report) : JSON.stringify(report, null, 2), "utf8");
        console.error(`wrote ${out}`);
      }
    } else {
      if (codemod === "apply" && cm) {
        console.error(
          cm.applied && cm.files.length > 0
            ? `scale-audit: applied ${cm.patched} fix(es) to ${cm.files.length} file(s): ${cm.files.join(", ")}`
            : "scale-audit: no automated fixes were applied.",
        );
      }
      const output = format === "md" ? renderMarkdown(report) : JSON.stringify(report, null, 2);
      if (out) {
        const fs = await import("node:fs/promises");
        await fs.writeFile(out, output, "utf8");
        console.error(`wrote ${out}`);
      } else {
        console.log(output);
      }
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
