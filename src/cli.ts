#!/usr/bin/env node
import { runAudit } from "./runner.js";

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let source;
  let out;
  let verify = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out" || a === "-o") {
      out = args[++i];
    } else if (a === "--verify" || a === "-v") {
      verify = true;
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
  return { source, out, verify };
}

function printHelp() {
  console.log(`scale-audit - static scale-readiness audit for Node/TS repos

Usage:
  scale-audit <repo-url-or-local-path> [--out report.json] [--verify]

Options:
  --verify, -v   Experimental JEV check: apply auto-fixes to an isolated copy,
                 re-scan, and report validity percentages.
`);
}

async function main() {
  const { source, out, verify } = parseArgs(process.argv);
  try {
    const report = await runAudit(source, { verifyFixes: verify });
    const json = JSON.stringify(report, null, 2);
    if (out) {
      const fs = await import("node:fs/promises");
      await fs.writeFile(out, json, "utf8");
      console.error(`wrote ${out}`);
    } else {
      console.log(json);
    }
  } catch (err) {
    console.error("ERROR:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
