import type { Finding } from "./types.js";

const SEVERITY_WEIGHT: Record<Finding["severity"], number> = {
  critical: 20,
  high: 10,
  medium: 5,
  low: 2,
  info: 0,
};

/**
 * One repeated issue class (e.g. 100 unbounded reads) should not dominate the
 * score. Within a family the penalty decays geometrically, so the worst
 * finding counts in full and each further one counts half as much.
 */
const FAMILY_PENALTY_CAP = 20;
const DECAY = 0.5;

/**
 * How much each category matters to scale-readiness.
 *
 * Data access and concurrency break first and hardest, so they dominate the
 * headline score; documentation-level categories barely move it.
 */
const CATEGORY_WEIGHT: Record<string, number> = {
  DB: 4,
  Concurrency: 4,
  Connection: 3,
  Resilience: 3,
  "I/O": 2,
  Correctness: 3,
  Performance: 1,
  Observability: 1,
  Deps: 1,
};

const DEFAULT_CATEGORY_WEIGHT = 1;

export interface CategoryScore {
  category: string;
  /** 0-100; 100 means nothing was found in this category. */
  score: number;
  findings: number;
  /** Penalty points deducted from 100. */
  penalty: number;
  weight: number;
}

/**
 * Score a set of findings.
 *
 * The headline is a weighted average of the per-category scores, not a sum of
 * penalties. Summing penalties made every mature repository score 0, which
 * told the user nothing; averaging per category keeps the number meaningful
 * and shows *where* the risk actually is.
 */
export function scoreFindings(findings: Finding[]): { score: number; categories: CategoryScore[] } {
  const byFamily = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = JSON.stringify([f.category, f.id]);
    const arr = byFamily.get(key) ?? [];
    arr.push(f);
    byFamily.set(key, arr);
  }

  const byCategory = new Map<string, { penalty: number; findings: number }>();
  for (const familyFindings of byFamily.values()) {
    const category = familyFindings[0].category;
    const bucket = byCategory.get(category) ?? { penalty: 0, findings: 0 };
    bucket.penalty += familyPenalty(familyFindings);
    bucket.findings += familyFindings.length;
    byCategory.set(category, bucket);
  }

  // Keep the denominator fixed: adding a newly affected category must never
  // dilute the penalty from existing findings. Unknown categories also add
  // penalties against this same baseline.
  for (const category of Object.keys(CATEGORY_WEIGHT)) {
    if (!byCategory.has(category)) byCategory.set(category, { penalty: 0, findings: 0 });
  }
  const categories: CategoryScore[] = [];
  let weightedPenalty = 0;
  const totalWeight = Object.values(CATEGORY_WEIGHT).reduce((sum, weight) => sum + weight, 0);
  for (const [category, bucket] of byCategory) {
    const weight = CATEGORY_WEIGHT[category] ?? DEFAULT_CATEGORY_WEIGHT;
    const sub = Math.max(0, Math.round(100 - bucket.penalty));
    categories.push({ category, score: sub, findings: bucket.findings, penalty: Math.round(bucket.penalty * 10) / 10, weight });
    weightedPenalty += Math.min(100, bucket.penalty) * weight;
  }

  categories.sort((a, b) => a.score - b.score);
  const score = Math.max(0, Math.min(100, Math.floor(100 - weightedPenalty / totalWeight)));
  return { score, categories };
}

/**
 * The penalty for one issue class.
 *
 * Findings are ordered worst-first; the first counts in full, the second
 * counts half, the third a quarter, and so on. That way a class with one
 * serious problem and a class with two hundred trivial ones end up close,
 * without a single class being able to zero the whole repository.
 */
function effectiveWeight(f: Finding): number {
  return SEVERITY_WEIGHT[f.severity] * (f.confidence === "low" ? 0.5 : 1);
}

export function familyPenalty(findings: Finding[]): number {
  const sorted = [...findings].sort((a, b) => effectiveWeight(b) - effectiveWeight(a));
  let penalty = 0;
  let factor = 1;
  for (const f of sorted) {
    penalty += effectiveWeight(f) * factor;
    factor *= DECAY;
  }
  return Math.min(penalty, FAMILY_PENALTY_CAP);
}

export interface AuditOptions {
  /** "diff" generates a patch, "apply" also writes it to disk. */
  codemod?: "diff" | "apply";
}
