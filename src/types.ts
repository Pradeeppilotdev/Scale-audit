export type Severity = "critical" | "high" | "medium" | "low" | "info";

/** "application" | "library" | "unknown" — a library is not a scale target. */
export type ProjectType = "application" | "library" | "unknown";

export interface Finding {
  id: string;
  category: string;
  severity: Severity;
  confidence: "high" | "medium" | "low";
  file: string;
  line: number;
  snippet: string;
  message: string;
  scaleTrigger: string;
  suggestedFix: string;
}

export interface Fingerprint {
  framework: string | null;
  orm: string | null;
  hasTests: boolean;
  hasCI: boolean;
  deps: Record<string, string>;
  devDeps: Record<string, string>;
  fileCount: number;
  sourceFileCount: number;
  /** "application" | "library" | "unknown" — a library is not a scale target. */
  projectType: ProjectType;
}

/** A single automated fix that was generated for a finding. */
export interface CodemodEdit {
  findingId: string;
  file: string;
  line: number;
  description: string;
  safe: boolean;
}

export interface CodemodSummary {
  /** Combined unified diff, ready for `git apply`. */
  diff: string;
  /** Findings that produced a patch. */
  patched: number;
  /** Findings with no automated fix. */
  unpatched: number;
  edits: CodemodEdit[];
  /** Sites that need a manual fix rather than a generated patch. */
  manual: CodemodEdit[];
  /** Number of generated edits actually written to disk. */
  appliedEdits: number;
  /** True when at least one file was written to disk. */
  applied: boolean;
  /** Files that were changed on disk (only when applied). */
  files: string[];
}

export interface CategoryScore {
  category: string;
  /** 0-100; 100 means no scored findings were detected in this category. */
  score: number;
  findings: number;
  penalty: number;
  weight: number;
}

/** Explain the score separately from coverage and runtime readiness. */
export interface ScoreInterpretation {
  model: "weighted-static-findings-v1";
  meaning: string;
  categoryMeaning: string;
  calculation: string;
  familyPenaltyCap: number;
  subsequentFindingMultiplier: number;
  bySeverity: Record<Severity, number>;
  highPriorityFindings: number;
  reviewMessage: string;
}

export interface ReportSummary {
  total: number;
  bySeverity: Record<string, number>;
  byCategory: Record<string, number>;
  byConfidence: Record<string, number>;
  categories: CategoryScore[];
}

export interface AuditCoverage {
  discovered: number;
  analyzed: number;
  skipped: { file: string; reason: string }[];
}

export interface DetectorStatus {
  name: string;
  status: "complete" | "failed";
  reason?: string;
}

export interface Report {
  /** Optional for compatibility with reports created before schema versioning. */
  schemaVersion?: 1;
  analyzer?: { name: string; version: string };
  analysisScope?: { purpose: string; limitations: string[] };
  /** False when any detector failed or source coverage is incomplete. */
  complete?: boolean;
  detectors?: DetectorStatus[];
  coverage?: AuditCoverage;
  repo: string;
  commit: string | null;
  scannedAt: string;
  fingerprint: Fingerprint;
  findings: Finding[];
  score: number;
  /** Optional so reports produced before score interpretation remain readable. */
  scoreInterpretation?: ScoreInterpretation;
  firstBottleneck: Finding | null;
  notes: string[];
  summary?: ReportSummary;
  codemod?: CodemodSummary;
}
