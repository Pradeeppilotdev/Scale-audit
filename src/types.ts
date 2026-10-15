export type Severity = "critical" | "high" | "medium" | "low" | "info";

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
}

export interface VerificationResult {
  file: string;
  line: number;
  findingId: string;
  category: "auto" | "manual";
  patchApplied: boolean;
  validity: number | null; // positive percentage 0-100
  method: string;
  detail: string;
}

export interface Report {
  repo: string;
  commit: string | null;
  scannedAt: string;
  fingerprint: Fingerprint;
  findings: Finding[];
  score: number;
  firstBottleneck: Finding | null;
  notes: string[];
  verification?: VerificationResult[];
}
