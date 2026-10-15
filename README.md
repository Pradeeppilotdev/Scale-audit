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

## Detectors (v0.2)
- DB: N+1 queries, unbounded reads, missing Prisma indexes
- Concurrency: in-process session/rate-limit/state, WebSockets without shared adapter, unbounded `Promise.all` over maps
- I/O: blocking sync calls in request paths, image processing in handlers
- Resilience: outbound HTTP without timeout/abort signal
- Lifecycle: missing health endpoint, missing graceful shutdown
- Deps: heavy/deprecated packages

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
          fail-on: critical
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
