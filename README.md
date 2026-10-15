# scale-audit (M1: CLI)

Static scale-readiness audit for public Node.js/TypeScript repos. Clones (read-only) and emits JSON findings.

## Usage
```bash
npm run analyze -- <repo-url-or-path> [--out report.json]
```

Examples:
```bash
npm run analyze -- ./my-app
npm run analyze -- https://github.com/owner/repo --out report.json
```

## What it checks (v1)
- N+1 queries in loops
- Unbounded DB reads (missing pagination)
- Missing indexes vs Prisma filters
- In-process state / session / rate limiter
- Sync I/O and image processing in request paths
- Heavy/deprecated dependencies

## Experimental JEV verification
```bash
scale-audit https://github.com/owner/repo --verify
```
Applies auto-fixes to an isolated copy and reports a validity percentage (currently covers unbounded reads).

- Never executes target code. Static readers only. Clones are deleted after analysis.

## Next steps
- Expand detector catalog and validate on 10+ real repos before web UI (M2).
```