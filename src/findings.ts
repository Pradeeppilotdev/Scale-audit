import type { Finding } from "./types.js";

export const SEVERITY_RANK: Record<Finding["severity"], number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

/** Merge detector output without argument-count limits or pairwise site scans. */
export function mergeFindings(groups: Iterable<Iterable<Finding>>): Finding[] {
  const sites = new Map<string, Finding>();
  const nPlusOneSites = new Set<string>();
  for (const group of groups) for (const finding of group) {
    const key = JSON.stringify([finding.id, finding.file, finding.line, finding.column, finding.message]);
    const previous = sites.get(key);
    if (previous && (SEVERITY_RANK[previous.severity] > SEVERITY_RANK[finding.severity]
      || previous.severity === finding.severity && CONFIDENCE_RANK[previous.confidence] >= CONFIDENCE_RANK[finding.confidence])) continue;
    sites.set(key, finding);
    if (finding.id === "n-plus-one") nPlusOneSites.add(JSON.stringify([finding.file, finding.line, finding.column]));
  }
  // An N+1 already describes the underlying read at the same source location.
  return Array.from(sites.values()).filter(finding => finding.id !== "unbounded-read"
    || !nPlusOneSites.has(JSON.stringify([finding.file, finding.line, finding.column])));
}
