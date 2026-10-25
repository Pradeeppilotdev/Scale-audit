#!/usr/bin/env node
import { runAudit } from "./runner.js";
import { renderMarkdown } from "./reportMarkdown.js";
import { isRemote } from "./clone.js";
import type { Severity } from "./types.js";
import { assertSupportedNode } from "./runtime.js";

const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

interface Args {
  debug: boolean;
  source: string;
  out?: string;
  format: "json" | "md";
  failOn?: Severity;
  codemod?: "diff" | "apply";
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let debug = false;
  let source: string | undefined;
  let out: string | undefined;
  let format: "json" | "md" = "json";
  let failOn: Severity | undefined;
  let codemod: "diff" | "apply" | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--debug") {
      debug = true;
    } else if (a === "--out" || a === "-o") {
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
      if (!Object.hasOwn(SEVERITY_RANK, next)) throw new Error(`unknown --fail-on value: ${next}`);
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
  return { source, out, format, failOn, codemod, debug };
}

function printHelp() {
  console.log(`scale-audit - static scale-readiness audit for Node/TS repos

Usage:
  scale-audit <repo-url-or-local-path-or-file> [options]

Options:
  -o, --out <file>       Write report to a file (default: stdout)
  --format <json|md>     Output format (default: json)
  --diff                 Print a unified diff with automated fixes for the findings
  --fix                  Apply safe fixes in place; skip review-required file plans (local only)
  --fail-on <severity>   Exit with code 2 when a finding at/above this severity
                         exists (critical|high|medium|low). Useful for CI.
  --debug                Write raw detector errors/stacks to stderr (may contain private paths).
  Exit codes: 0 complete, 1 fatal/input error, 2 severity threshold, 3 incomplete audit.
  -h, --help             Show this help.
`);
}

async function main() {
  let debug = false;
  try {
    assertSupportedNode();
    const args = parseArgs(process.argv);
    debug = args.debug;
    const { source, out, format, failOn, codemod } = args;
    if (codemod === "apply" && isRemote(source)) {
      console.error("scale-audit: --fix only works on a local path; a cloned repo is discarded after the audit.");
      process.exit(1);
    }

    const report = await runAudit(source, { codemod,
      onDiagnostic: debug ? (detector, error) => console.error(`scale-audit: ${detector}:`, error) : undefined,
    });
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
            ? `scale-audit: applied ${cm.appliedEdits} fix(es) to ${cm.files.length} file(s): ${cm.files.join(", ")}`
            : "scale-audit: no automated fixes were applied.",
        );
        if (cm.edits.some((edit) => !edit.safe)) {
          console.error("scale-audit: review-required suggestions were not applied; inspect them with --diff.");
        }
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
    if (report.complete === false) {
      console.error("scale-audit: incomplete audit; score reflects successful checks only. No fixes were applied.");
      process.exitCode = 3;
    }
  } catch (err) {
    console.error("ERROR:", debug && err instanceof Error ? err.stack : err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

await main();
