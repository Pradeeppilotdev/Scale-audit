/** Bound total analysis work as well as recursion depth. Never silently omit work. */
export class AnalysisBudget {
  private remaining: number;
  constructor(private readonly label: string, limit = 50_000) { this.remaining = limit; }
  take(count = 1): void {
    this.remaining -= count;
    if (this.remaining < 0) throw new Error(`${this.label} analysis work budget exceeded`);
  }
}
