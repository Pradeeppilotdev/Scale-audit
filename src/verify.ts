import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Finding, VerificationResult } from "./types.js";
import { detectUnboundedReads } from "./detectors/unbounded.js";

const AUTO_IDS = new Set(["unbounded-read"]);

export async function verifyFindings(root: string, findings: Finding[]): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];

  // Prepare isolated mutable copy so user repo is never touched.
  const work = mkdtempSync(path.join(tmpdir(), "scale-audit-verify-"));
  try {
    cpSync(root, work, {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}node_modules`) && !src.includes(`${path.sep}.git`),
    });

    const autoFindings = findings.filter((f) => AUTO_IDS.has(f.id));
    const manualFindings = findings.filter((f) => !AUTO_IDS.has(f.id));

    // Baseline count before patching.
    const baseline = await detectUnboundedReads(work);
    const baselineByFile = countByFile(baseline);

    // Group findings per file and apply patches line-by-line.
    const byFile = new Map<string, Finding[]>();
    for (const f of autoFindings) {
      const arr = byFile.get(f.file) ?? [];
      arr.push(f);
      byFile.set(f.file, arr);
    }

    const patchedFiles = new Set<string>();
    for (const [rel, fs] of byFile) {
      const full = path.join(work, rel);
      let content: string;
      try { content = readFileSync(full, "utf8"); } catch { continue; }
      const uniqueLines = [...new Set(fs.map((f) => f.line))];
      const patched = patchUnboundedFile(content, uniqueLines);
      if (patched !== content) {
        writeFileSync(full, patched, "utf8");
        patchedFiles.add(rel);
      }
    }

    const after = patchedFiles.size > 0 ? await detectUnboundedReads(work) : baseline;
    const afterByFile = countByFile(after);

    const totalBaseline = [...baselineByFile.values()].reduce((a, b) => a + b, 0);
    const totalAfter = [...afterByFile.values()].reduce((a, b) => a + b, 0);

    for (const f of autoFindings) {
      const patched = patchedFiles.has(f.file);
      const before = baselineByFile.get(f.file) ?? 0;
      const remaining = afterByFile.get(f.file) ?? 0;
      const removed = Math.max(0, before - remaining);
      // Validity is computed against this file only, so one bad patch cannot hide behind another file.
      const validity = patched ? (before > 0 ? Math.round((removed / before) * 100) : 0) : null;
      results.push({
        file: f.file,
        line: f.line,
        findingId: f.id,
        category: "auto",
        patchApplied: patched,
        validity,
        method: "patch+rescan",
        detail: patched
          ? `Unbounded reads in ${f.file}: ${before} -> ${remaining} after adding bounded pagination (repo total ${totalBaseline} -> ${totalAfter}).`
          : "No safe automatic patch could be applied to this site (ambiguous call); verify manually.",
      });
    }

    for (const f of manualFindings) {
      results.push({
        file: f.file,
        line: f.line,
        findingId: f.id,
        category: "manual",
        patchApplied: false,
        validity: null,
        method: "manual-verify",
        detail: "Automated fix verification not available for this finding type; verify by running the suggested refactor and re-auditing.",
      });
    }

    return results;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function countByFile(findings: Finding[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of findings) m.set(f.file, (m.get(f.file) ?? 0) + 1);
  return m;
}

function patchUnboundedFile(content: string, lines: number[]): string {
  const arr = content.split("\n");
  const target = new Set(lines);
  let changed = false;
  for (let i = 0; i < arr.length; i++) {
    if (!target.has(i + 1)) continue;
    const patched = patchUnboundedLine(arr[i]);
    if (patched !== arr[i]) {
      arr[i] = patched;
      changed = true;
    }
  }
  return changed ? arr.join("\n") : content;
}

/**
 * Only patches unambiguous ORM collection reads. Plain `.find()` is excluded:
 * it may be an array helper, and injecting `take` would produce broken code.
 */
function patchUnboundedLine(line: string): string {
  // No arguments: findMany() -> findMany({ take: 50 })
  if (/\.\w*\b(?:findMany|findAll)\s*\(\s*\)/.test(line)) {
    return line.replace(/(\.\w*(?:findMany|findAll)\s*\()\s*\)/, "$1{ take: 50 })");
  }
  // Object argument present: inject take into the first object.
  if (/\.\w*(?:findMany|findAll)\s*\(\s*\{/.test(line)) {
    return line.replace(/(\.\w*(?:findMany|findAll)\s*\(\s*\{)/, "$1 take: 50, ");
  }
  return line;
}
