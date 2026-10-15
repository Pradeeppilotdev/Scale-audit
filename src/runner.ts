import { fingerprintRepo } from "./fingerprint.js";
import { resolveRepo } from "./clone.js";
import { detectNPlusOne } from "./detectors/n1.js";
import { detectUnboundedReads } from "./detectors/unbounded.js";
import { detectMissingIndexes } from "./detectors/missingIndex.js";
import { detectInProcessState } from "./detectors/inProcessState.js";
import { detectSyncIo } from "./detectors/syncIo.js";
import { detectOutboundTimeouts } from "./detectors/outboundTimeout.js";
import { detectUnboundedConcurrency } from "./detectors/unboundedConcurrency.js";
import { detectLifecycle } from "./detectors/lifecycle.js";
import type { Fingerprint, Finding, Report } from "./types.js";
import { verifyFindings } from "./verify.js";

const SEVERITY_WEIGHT: Record<Finding["severity"], number> = {
  critical: 20,
  high: 10,
  medium: 5,
  low: 2,
  info: 0,
};

export interface AuditOptions { verifyFixes?: boolean; }

export async function runAudit(input: string, options: AuditOptions = {}): Promise<Report> {
  const { root, commit, cleanup } = await resolveRepo(input);
  try {
    const fingerprint = await fingerprintRepo(root);

    const findings: Finding[] = [];
    const tasks = [
      detectNPlusOne(root),
      detectUnboundedReads(root),
      detectMissingIndexes(root),
      detectInProcessState(root),
      detectSyncIo(root),
      detectOutboundTimeouts(root),
      detectUnboundedConcurrency(root),
      detectLifecycle(root),
    ];
    const results = await Promise.all(tasks);
    for (const r of results) findings.push(...r);

    // also deps/CVE-ish basic signals
    findings.push(...dependencySignals(fingerprint));

    const deduped = dedupeFindings(findings);
    findings.length = 0;
    findings.push(...deduped);

    findings.sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]);

    const score = Math.max(0, Math.min(100, 100 - findings.reduce((s, f) => s + SEVERITY_WEIGHT[f.severity], 0)));

    let firstBottleneck: Finding | null = null;
    const order: Finding["severity"][] = ["critical", "high", "medium", "low"];
    for (const sev of order) {
      const f = findings.find((x) => x.severity === sev);
      if (f) { firstBottleneck = f; break; }
    }

    const notes: string[] = [];
    if (!fingerprint.hasTests) notes.push("No tests detected; confidence in findings is lower.");
    if (!fingerprint.hasCI) notes.push("No CI configuration detected.");
    if (fingerprint.sourceFileCount > 20000) notes.push("Large repo; analysis may be incomplete due to caps.");

    const report: Report = {
      repo: input,
      commit,
      scannedAt: new Date().toISOString(),
      fingerprint,
      findings,
      score,
      firstBottleneck,
      notes,
    };

    if (options.verifyFixes) {
      report.verification = await verifyFindings(root, findings);
    }

    return report;
  } finally {
    await cleanup();
  }
}

function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const exact: Finding[] = [];
  for (const f of findings) {
    const key = `${f.id}|${f.file}|${f.line}|${f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    exact.push(f);
  }
  // An N+1 includes the underlying read; suppress the duplicate unbounded-read at the same spot.
  const n1 = exact.filter((f) => f.id === "n-plus-one");
  return exact.filter((f) => {
    if (f.id !== "unbounded-read") return true;
    return !n1.some((n) => n.file === f.file && n.line === f.line);
  });
}

function dependencySignals(fp: Fingerprint): Finding[] {
  const out: Finding[] = [];
  const deps = { ...fp.deps, ...fp.devDeps };
  // Heavy/known risky libs
  const heavy = ["moment", "lodash", "request", "bluebird"];
  for (const lib of heavy) {
    if (deps[lib]) {
      out.push({
        id: "heavy-dependency",
        category: "Deps",
        severity: "low",
        confidence: "high",
        file: "package.json",
        line: 1,
        snippet: `"${lib}": "${deps[lib]}"`,
        message: `Dependency "${lib}" is heavy/deprecated-prone; consider lighter alternatives.`,
        scaleTrigger: "Increases bundle/runtime footprint and maintenance risk.",
        suggestedFix: "Replace with modern equivalents (e.g. dayjs/date-fns, native fetch, lodash-es tree-shaking).",
      });
    }
  }
  if (deps["dotenv"] && !fp.hasCI) {
    // not a scale issue; skip
  }
  return out;
}
