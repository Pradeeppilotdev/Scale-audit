# scale-audit

Static scale-readiness audit for **public Node.js/TypeScript repos**. Clones read-only, infers likely bottlenecks, and reports evidence-backed fixes.

Published: `@pradeeppilot/scale-audit`

## Usage

```bash
npx @pradeeppilot/scale-audit <repo-url-or-path> [options]
```

Options:
- `-o, --out <file>` — write report to a file
- `--format <json|md>` — output format (default `json`)
- `--verify, -v` — experimental JEV check: auto-patch supported findings in an isolated copy, re-scan, report validity %
- `--fail-on <severity>` — exit code 2 if any finding at/above severity exists (`critical|high|medium|low`), for CI

Examples:
```bash
npx @pradeeppilot/scale-audit https://github.com/owner/repo --format md
npx @pradeeppilot/scale-audit ./my-app --format md --out report.md
npx @pradeeppilot/scale-audit ./my-app --verify
npx @pradeeppilot/scale-audit ./my-app --fail-on high
```

## Detectors (v0.3)
- DB: N+1 queries, unbounded reads (pagination-aware; raw SQL and TypeORM repository calls included), missing Prisma indexes (scoped to each project's own schema, relation/`OR`-safe)
- Concurrency: in-process session/rate-limit/state, WebSockets without shared adapter, unbounded `Promise.all` over user-sized collections
- I/O: blocking sync calls in request paths (startup/script calls downgraded), image processing in handlers
- Resilience: outbound HTTP without timeout/abort signal (shared `axios.create` clients honored; cancellation-only `signal`s and variable configs reported as low-confidence, since unmount/dispose signals do not bound a hung request)
- Lifecycle: missing health endpoint, missing graceful shutdown (AST-based, not comment/string matching)
- Deps: heavy/deprecated packages

Precision notes:
- Findings carry `confidence`; ambiguous cases (query/config passed as a variable) are reported as `low` instead of asserted.
- `--verify` only auto-patches unambiguous `findMany`/`findAll` calls and reports per-file validity.
- GraphQL/SDK clients (`client.query({ query })`) are not mistaken for DB reads; only raw-SQL shapes (`client.query("...")`, `{ text: "..." }`) are.

## Score

Starts at 100, subtracts weighted findings, but **each detector family (issue class) contributes at most 20 points** and low-confidence findings count half. One repeated issue can't pin a large repo at 0, so scores stay comparable across repo sizes.

Requires Node.js 20+.

## Local web UI (deferred preview)

The web UI/backend is **not the current focus** (npm CLI ships first; hosting + DB come later). A minimal preview still ships for local use:

```bash
npm run build
npm run serve          # http://127.0.0.1:8787
```

- Production-safe defaults: binds `127.0.0.1`, accepts **public github.com URLs only**, caps in-memory jobs, rejects symlinked/size-limit-exceeding files.
- For local development on a local folder: `SCALE_AUDIT_ALLOW_LOCAL=1 npm run serve`.
- Jobs are in-memory and analysis runs in-process; a real queue/DB/worker is the next milestone.

## GitHub Action (PR comment)
```yaml
permissions:
  contents: read
  pull-requests: write
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Pradeeppilotdev/Scale-audit/.github/actions/scale-audit@main
        with:
          fail-on: high
```

## Safety
- Never executes target code; static readers only.
- Clones are deleted after analysis.
- Test/examples/docs folders are skipped for detector noise.

## Development
```bash
npm ci
npm test
npm run build
```
