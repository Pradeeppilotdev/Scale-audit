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
    const arr = byFamily.get(f.id) ?? [];
    arr.push(f);
    byFamily.set(f.id, arr);
  }

  const byCategory = new Map<string, { penalty: number; findings: number }>();
  for (const familyFindings of byFamily.values()) {
    const category = familyFindings[0].category;
    const bucket = byCategory.get(category) ?? { penalty: 0, findings: 0 };
    bucket.penalty += familyPenalty(familyFindings);
    bucket.findings += familyFindings.length;
    byCategory.set(category, bucket);
  }

  const categories: CategoryScore[] = [];
  let weighted = 0;
  let totalWeight = 0;
  for (const [category, bucket] of byCategory) {
    const weight = CATEGORY_WEIGHT[category] ?? DEFAULT_CATEGORY_WEIGHT;
    const sub = Math.max(0, Math.round(100 - bucket.penalty));
    categories.push({ category, score: sub, findings: bucket.findings, penalty: Math.round(bucket.penalty * 10) / 10, weight });
    // A category where everything was informational carries no signal.
    if (bucket.penalty > 0) {
      weighted += sub * weight;
      totalWeight += weight;
    }
  }

  categories.sort((a, b) => a.score - b.score);
  const score = totalWeight === 0 ? 100 : Math.max(0, Math.min(100, Math.round(weighted / totalWeight)));
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
export function familyPenalty(findings: Finding[]): number {
  const sorted = [...findings].sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]);
  let penalty = 0;
  let factor = 1;
  for (const f of sorted) {
    const confidence = f.confidence === "low" ? 0.5 : 1;
    penalty += SEVERITY_WEIGHT[f.severity] * confidence * factor;
    factor *= DECAY;
  }
  return Math.min(penalty, FAMILY_PENALTY_CAP);
}

export interface AuditOptions {
  /** "diff" generates a patch, "apply" also writes it to disk. */
  codemod?: "diff" | "apply";
}
