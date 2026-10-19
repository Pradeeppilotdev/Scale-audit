# scale-audit

**Find what breaks your Node.js/TypeScript app under load — before your users do.**

Static, read-only audit for public repos: flags N+1 queries, unbounded reads, missing DB indexes, floating promises, per-request connection pools, missing timeouts, blocking I/O, and lifecycle gaps. No code execution, no runtime agent — point it at a repo, or run it on every PR.

[![npm version](https://img.shields.io/npm/v/@pradeeppilot/scale-audit)](https://www.npmjs.com/package/@pradeeppilot/scale-audit)
[![ci](https://github.com/Pradeeppilotdev/Scale-audit/actions/workflows/ci.yml/badge.svg)](https://github.com/Pradeeppilotdev/Scale-audit/actions/workflows/ci.yml)
[![Node >= 20](https://img.shields.io/node/v/@pradeeppilot/scale-audit)](https://www.npmjs.com/package/@pradeeppilot/scale-audit)
[![license](https://img.shields.io/npm/l/@pradeeppilot/scale-audit)](https://github.com/Pradeeppilotdev/Scale-audit/blob/main/LICENSE)

```bash
npx @pradeeppilot/scale-audit https://github.com/owner/repo --format md
```

Trimmed output from a real Next.js app:

```text
# Scale-Readiness Report

- Repo: `https://github.com/owner/repo`
- Framework: Next.js
- ORM: Prisma
- Project type: application

## Verdict

**Scale score: 74/100**

First bottleneck: **DB** — ORM/database call awaited inside a loop; this is an N+1 pattern that scales poorly.
- Evidence: `apps/web/app/api/cron/bookingReminder/route.ts:27`
- Why: Breaks as list/collection sizes grow: O(n) DB round-trips per request.
- Fix: Batch the read (e.g. Prisma findMany with `in`, or a join) and hydrate in memory.

## Score by category

| Category | Score | Findings |
| --- | --- | --- |
| DB | 30/100 | 518 |
| Resilience | 75/100 | 210 |
| I/O | 78/100 | 84 |
```

## Usage

```bash
npx @pradeeppilot/scale-audit <repo-url-or-path> [options]
```

Options:
- `-o, --out <file>` — write report to a file
- `--format <json|md>` — output format (default `json`)
- `--diff` — print a unified diff with automated fixes for the findings
- `--fix` — apply those automated fixes in place (local paths only)
- `--fail-on <severity>` — exit code 2 if any finding at/above severity exists (`critical|high|medium|low`), for CI

```bash
npx @pradeeppilot/scale-audit ./my-app --format md --out report.md
npx @pradeeppilot/scale-audit ./my-app --diff > fixes.patch && git apply fixes.patch
npx @pradeeppilot/scale-audit ./my-app --fix
npx @pradeeppilot/scale-audit ./my-app --fail-on high
```

## Automated fixes

`--diff` turns findings into a real, reviewable patch. Every change is anchored to an exact AST offset, so the result is valid code, and the output is a standard unified diff you can pipe straight into `git apply`:

```diff
--- a/apps/web/app/api/users/route.ts
+++ b/apps/web/app/api/users/route.ts
@@ -8,7 +8,7 @@
 export async function GET() {
-  const users = await prisma.user.findMany();
+  const users = await prisma.user.findMany({ take: 50 });
   return Response.json(users);
 }
```

`--fix` applies the same patch to the working tree. Both are opt-in: a plain audit never writes to the target repository.

## Detectors

**DB** — N+1 queries, unbounded reads (pagination-aware), unbounded raw SQL (`$queryRaw`/`knex.raw` with no `LIMIT`), missing Prisma indexes (scoped to each project's own schema, composite-index aware)
**Concurrency** — in-process session/rate-limit/state, WebSockets without a shared adapter, unbounded `Promise.all` over user-sized collections
**Connection** — a `PrismaClient`/`Pool` created per request instead of once per process
**Correctness** — floating promises (an unawaited write that may never land) and `.then()` without `.catch()`
**I/O** — blocking sync calls in request paths, image processing in handlers
**Resilience** — outbound HTTP without a timeout/abort signal, unhandled rejections, missing graceful shutdown, missing retry strategy
**Performance** — independent calls awaited one after the other instead of concurrently
**Observability** — missing health endpoint
**Deps** — heavy/deprecated packages

## Score

The score is a **weighted average of per-category scores**, not a sum of penalties.

- Each category is scored out of 100 on its own, so you can see exactly where the risk is (`DB 30/100`).
- Within an issue class the penalty decays: the worst finding counts in full, the next counts half, and so on, with a cap per class. One repeated issue cannot pin a large repo at 0.
- Low-confidence findings count half.
- Categories are weighted by how much they matter under load: DB and Concurrency weigh 4, Performance weighs 1.

This keeps the number comparable between a 70-file app and a 700-file monorepo, and comparable between a young project and a mature one.

## Precision

A linter that cries wolf gets uninstalled, so every finding is grounded in evidence:

- A capitalised receiver is only treated as a database model when there is proof — it is bound to a model factory, imported from an entity/model path, or present in a Prisma schema. `UserService.find()` is not a database read.
- Aggregates (`count`, `aggregate`, `groupBy`) are bounded by construction and are never reported.
- A module-level `Map`/`Set` that is only filled at import time is a constant, not runtime state.
- A client built in a constructor or assigned to a field is a singleton, not a per-request pool.
- Query-builder methods (`select`, `from`, `where`) are not reads on their own; only the completed chain is.
- GraphQL/SDK clients (`client.query({ query })`) are not mistaken for raw SQL.
- Findings carry `confidence`; ambiguous cases (query or config passed as a variable) are reported as `low` instead of asserted.
- A request path is matched on whole path segments, so `capitalize.ts` is not treated as an API route.

## CI integration

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

The action comments the findings on the pull request and fails the build when a finding at or above the threshold exists.

## Local web UI (deferred preview)

The web UI/backend is **not the current focus** (npm CLI ships first; hosting + DB come later). A minimal preview still ships for local use:

```bash
npm run build
npm run serve          # http://127.0.0.1:8787
```

- Production-safe defaults: binds `127.0.0.1`, accepts **public github.com URLs only**, caps in-memory jobs, rejects symlinked/size-limit-exceeding files.
- For local development on a local folder: `SCALE_AUDIT_ALLOW_LOCAL=1 npm run serve`.
- Jobs are in-memory and analysis runs in-process; a real queue/DB/worker is the next milestone.

## Safety

- Never executes target code; static readers only.
- Clones are deleted after analysis.
- Test/examples/docs folders are skipped for detector noise.
- `--fix` is opt-in and only ever touches a local path you passed in.

## Development

```bash
npm ci
npm test
npm run build
```

Requires Node.js 20+.
