import ts from "typescript";

/** Safe, internally generated analysis-limit explanations for public reports. */
export class AnalysisLimitError extends Error {
  constructor(message: string) { super(message); this.name = "AnalysisLimitError"; }
}

/** Bound total analysis work as well as recursion depth. Never silently omit work. */
export class AnalysisBudget {
  private remaining: number;
  constructor(private readonly label: string, limit = 50_000) { this.remaining = limit; }
  take(count = 1): void {
    this.remaining -= count;
    if (this.remaining < 0) throw new AnalysisLimitError(`${this.label} analysis work budget exceeded`);
  }
}

// Cache AST sizes: all whole-project analyses share the same immutable sources.
const sizes = new WeakMap<ts.SourceFile, number>();
export function projectWorkLimit(sources: Iterable<ts.SourceFile>): number {
  let nodes = 0, files = 0;
  for (const source of sources) {
    files++;
    let size = sizes.get(source);
    if (size === undefined) {
      size = 0;
      const pending: ts.Node[] = [source];
      while (pending.length) {
        const node = pending.pop()!;
        size++;
        ts.forEachChild(node, child => { pending.push(child); });
      }
      sizes.set(source, size);
    }
    nodes += size;
  }
  // Allow ordinary linear passes and graph bookkeeping, with a hard ceiling.
  // Local static-evaluation/depth limits remain independent and unchanged.
  return Math.min(20_000_000, Math.max(200_000, files * 1_000, nodes * 20));
}
