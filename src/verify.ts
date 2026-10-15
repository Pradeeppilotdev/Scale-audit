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

    // Baseline count for targeted files (unpatched).
    const baseline = await detectUnboundedReads(work);
    const baselineByFile = countByFile(baseline);

    // Apply patches per file for all auto findings.
    const byFile = new Map<string, Finding[]>();
    for (const f of autoFindings) {
      const arr = byFile.get(f.file) ?? [];
      arr.push(f);
      byFile.set(f.file, arr);
    }

    let patchedAny = false;
    for (const [rel, fs] of byFile) {
      const full = path.join(work, rel);
      let content: string;
      try { content = readFileSync(full, "utf8"); } catch { continue; }
      const uniqueLines = [...new Set(fs.map((f) => f.line))];
      const patched = patchUnboundedFile(content, uniqueLines);
      if (patched !== content) {
        writeFileSync(full, patched, "utf8");
        patchedAny = true;
      }
    }

    const after = patchedAny ? await detectUnboundedReads(work) : baseline;
    const afterByFile = countByFile(after);

    const totalBaseline = baselineByFile.size === 0 ? 0 : [...baselineByFile.values()].reduce((a, b) => a + b, 0);
    const totalAfter = [...afterByFile.values()].reduce((a, b) => a + b, 0);
    const removed = Math.max(0, totalBaseline - totalAfter);
    const validityPct = autoFindings.length > 0
      ? Math.round((removed / autoFindings.length) * 100)
      : null;

    for (const f of autoFindings) {
      results.push({
        file: f.file,
        line: f.line,
        findingId: f.id,
        category: "auto",
        patchApplied: patchedAny,
        validity: validityPct,
        method: "patch+rescan",
        detail: patchedAny
          ? `Unbounded reads in files: ${totalBaseline} -> ${totalAfter} after adding bounded pagination.`
          : "No patch could be applied automatically.",
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
  // If line numbers shifted due to earlier edits we still patch best-effort by exact lines only.
  return changed ? arr.join("\n") : content;
}

function patchUnboundedLine(line: string): string {
  // No arguments: findMany() -> findMany({ take: 50 })
  if (/\.\w*\bfindMany\s*\(\s*\)/.test(line) || /\.\w*\bfind\s*\(\s*\)/.test(line)) {
    return line.replace(/(\.\w*(?:findMany|find)\s*\()\s*\)/, "$1{ take: 50 })");
  }
  // Object argument present: inject take into first object.
  if (/\.\w*(?:findMany|findAll|findUnique|findFirst|findByPk|find)\s*\(\s*\{/.test(line)) {
    return line.replace(/(\.\w*(?:findMany|findAll|findUnique|findFirst|findByPk|find)\s*\(\s*\{)/, "$1 take: 50, ");
  }
  return line;
}
