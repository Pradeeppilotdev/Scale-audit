# scale-audit

**Find what breaks your Node.js/TypeScript app under load — before your users do.**

Static, read-only audit for public repos: flags N+1 queries, unbounded reads, missing DB indexes, floating promises, per-request connection pools, missing timeouts, blocking I/O, and lifecycle gaps. No code execution, no runtime agent — point it at a repo, or run it on every PR.

[![npm version](https://img.shields.io/npm/v/@pradeeppilot/scale-audit)](https://www.npmjs.com/package/@pradeeppilot/scale-audit)
[![ci](https://github.com/Pradeeppilotdev/Scale-audit/actions/workflows/ci.yml/badge.svg)](https://github.com/Pradeeppilotdev/Scale-audit/actions/workflows/ci.yml)
[![Security-patched Node.js 22/24/26](https://img.shields.io/node/v/@pradeeppilot/scale-audit)](https://www.npmjs.com/package/@pradeeppilot/scale-audit)
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

## Purpose: system-design risks visible in code

The goal is to find implementation choices that undermine a system under load: unbounded work, repeated database round-trips, incorrectly shared state, connection lifetime mistakes, missing deadlines, and gaps in service startup and failure handling. Each finding should connect code evidence to a failure scenario and a concrete repair.

Static source analysis cannot establish production capacity, deployment topology, queue guarantees, data consistency, or database execution plans. A complete audit means the supported checks finished over eligible source; it does not mean every runtime behavior was understood. This tool does not replace load testing, architecture review, security scanning, or type checking.

Reports include the installed analyzer version, report schema version, and explicit analysis limits. Dependency-name advisories are informational and do not reduce the score; actual runtime impact needs evidence.

High-severity synchronous I/O requires a visible request callback or invoked helper path. The request graph follows native Node HTTP callbacks, common route registrations, local/imported helpers, native `call`/`bind` helpers, visible constructors, callback arguments and stable method references. Arrow functions retain lexical receivers; class members distinguish static and instance ownership, including visible constructor replacement objects. Literal guards, known synchronous throwing helpers and statement completion exclude unreachable request work and factory returns. Importing a module alone no longer promotes all of its functions to request-path severity. Native callback analysis follows visible argument values, defaults and receivers, including Promise executors and `Array.from`; known empty collections and incompatible settled promise branches do not establish execution. Unknown collection methods (including collections loaded from arbitrary JSON), payloads and thenables remain conservative. Exported server factories and supported framework handler conventions remain potential entry points; unresolved wrappers, dynamic dispatch and receiver mutation retain uncertain warnings rather than proving a request path or CLI isolation. This is bounded static call analysis, not a complete runtime call graph; exhausting its work budget marks the detector incomplete. Invocation signatures are cached without mixing resolution modes, and uncached signature traversal, default-value copies and bound-argument copies count toward the existing work budget.

Constructor reachability follows native JavaScript initialization order, including base instance fields before parameter defaults, executed lexical `super()` wrappers and inherited replacement objects. Construction completion tracks initialized `this` along each visible path, including `super()` in defaults. Alternative method targets, explicit `call`/`bind` receivers and native callback receivers retain their identities. Call arguments follow evaluation order; a known throw excludes later arguments and the callee. Callback guards consider all visible payload alternatives; nested arrays remain array values, and `undefined` is replaced by a selected default. Arrays retain their shape through supported readonly helper calls and native callback array arguments, while visible prototype mutation invalidates empty-collection proofs. Binding and completion summaries retain depth costs when reused. Callable projections and readonly consumer checks are cached and charge uncached member inspection to the existing work budget.

Lifecycle checks follow visible startup calls and runtime imports per service, including directly called local setup helpers. Health evidence must belong to the listening server or an explicitly root-mounted router. Nest health checks compose controller/method paths and follow static module imports/controllers from the application's root module. Package metadata is scoped to the nearest manifest. Conditionally started servers remain candidates for lifecycle findings, while only established startup execution supplies protection evidence. Direct helper arguments and executed parameter defaults retain their bindings; deferred generators and catch-only setup do not establish protection. Unknown external setup callbacks, constructor-driven setup, dynamic module registration, Fastify route-object health declarations and non-root router mount prefixes may require manual review. A registered route is evidence of routing, not proof that middleware sends a successful health response. Shared module summaries and a source-to-entry index avoid repeatedly traversing common imports; exhausted analysis still marks the report incomplete. Signal/rejection listeners establish registration evidence only, not proof of successful draining or recovery.

Startup checks retain argument bindings and allocation identity for each helper invocation. Immutable local receiver and callback aliases preserve those bindings; destructured helper parameters remain conservative. Static imports and re-exports are evaluated before the module body. Awaited helpers and literal local imports contribute completed setup evidence to later startup work; helper evidence stays tied to its invocation, and asynchronous continuations do not protect earlier listeners. Awaited call arguments complete before the call itself starts. Known literal guards retain their evaluated execution path, while unknown guards remain uncertain. Conditional logical and optional-chain paths retain their skipped execution paths, including computed callee keys. Native rejected/pending awaits, returned awaits and finally completion overrides are distinguished. Visible Nest metadata member/array mutations are scoped to executed service owners and helper invocations; metadata aliases, property reassignment and copied-array capture are tracked alongside helper-supplied root modules. Nest metadata capture includes class static initialization. Route literals preserve erased TypeScript wrappers and captured property values. Decorator expressions follow the configured evaluation order; arbitrary returned decorator bodies remain conservative. Server discovery recognizes imported Koa constructors and Node HTTP/HTTPS factories independently of the receiver variable name. Listener discovery reuses shared summary indexes, and protection call sets are composed lazily without copying them into every entry. Traversal remains budgeted.

Next priorities are baseline comparisons with reasoned suppressions, stable finding identities and SARIF export, and a repeatable real-repository precision/performance corpus. Further system-design checks should target demonstrable mechanisms such as queue backpressure, bounded caches, and retry amplification, with positive and negative examples before scoring them.

## Usage

```bash
npx @pradeeppilot/scale-audit <repo-url-or-path-or-file> [options]
```

Options:
- `-o, --out <file>` — write report to a file
- `--format <json|md>` — output format (default `json`)
- `--diff` — print a unified diff with automated fixes for the findings
- `--fix` — apply only automatically safe fixes in place (local paths only); review-required suggestions remain unchanged
- `--fail-on <severity>` — exit code 2 if any finding at/above severity exists (`critical|high|medium|low`), for CI

```bash
npx @pradeeppilot/scale-audit ./my-app --format md --out report.md
npx @pradeeppilot/scale-audit ./my-app --diff > fixes.patch
# Review fixes.patch before applying it:
git apply --check fixes.patch && git apply fixes.patch
npx @pradeeppilot/scale-audit ./my-app --fix
npx @pradeeppilot/scale-audit ./my-app --fail-on high
```

Local inputs can be a folder or an individual `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, or `.cjs` source file:

```bash
npx @pradeeppilot/scale-audit ./src/server.mts --format md
```

Single-file audits analyze only the selected file (including for `--diff` and `--fix`). The nearest valid parent `package.json` selects the project root (stopping at a Git boundary), and package/Prisma metadata are read from that project; lifecycle findings cannot account for sibling source files. Declaration files (`.d.ts`, `.d.mts`, `.d.cts`) are excluded.

JSON reports include `coverage` with discovered and analyzed source counts and skipped paths/reasons. Markdown and HTML show the same accounting and warn when files were skipped or no source was analyzed. Counts cover eligible discovered source files after the normal directory, hidden-file, symlink, and test exclusions; excluded paths are not included. Scores apply only to analyzed source, and skipped files can still contain issues.

Timeout detection checks the configuration position for each Axios method, recognizes positive literal Axios timeouts and explicit timer signals, and applies `axios.create()` defaults only to the corresponding variable binding. References to mutable defaults or client reassignment make inherited settings uncertain. Unsupported fetch timeout properties, disabled Axios timeouts, and Node HTTP timeout events alone do not establish request cancellation. Configurations that cannot be resolved are reported with low confidence.

## Automated fixes

`--diff` turns supported findings into a reviewable unified patch. Changes use AST offsets and pass syntax validation; ambiguous same-line calls and unsupported configurations are left for manual repair. Syntax validity does not guarantee type correctness or preserve application behavior. Review the patch before using `git apply`:

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

`--fix` applies only file plans whose edits are all marked safe. Pagination changes (which can truncate results) and added `await`s require review and are offered only by `--diff`; if a file contains any review-required edit, `--fix` skips that entire file. Raw SQL is never automatically rewritten. Existing cancellation/timeout options, variable configs, changed files, and symlinked paths are not overwritten. Reports distinguish generated suggestions from edits actually applied. Both modes are opt-in: a plain audit never writes to the target repository. Combining `--fix` with `--diff` or its deprecated `--verify`/`-v` aliases is rejected before auditing or writing files, in either argument order.

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

- All nine detector categories contribute to a fixed scoring baseline, including categories with no findings. Adding findings cannot improve the score. Unknown categories add penalties against the same baseline.
- Each category is scored out of 100 on its own, so you can see exactly where the risk is (`DB 30/100`).
- Within an issue class the penalty decays: the worst finding counts in full, the next counts half, and so on, with a cap per class. One repeated issue cannot pin a large repo at 0.
- Low-confidence findings count half.
- Categories are weighted by how much they matter under load: DB and Concurrency weigh 4, Performance weighs 1.

Scores use the fixed baseline and differ from earlier releases that averaged only affected categories. Repositories of different sizes use the same scoring rules. Compare the underlying findings, analysis scope and coverage alongside the number; it does not rank their actual runtime capacity.

The number summarizes **detected static findings**. It does not measure production capacity or certify scale readiness. Repetition caps and category averaging can leave a score such as 98/100 alongside high-severity findings that still need attention. Markdown and HTML place severity counts and a high-priority review message next to the score; JSON includes the same accounting and calculation notes in `scoreInterpretation`. CI decisions continue to use `--fail-on` severities independently of the score.

A category score of 100 means **no scored findings were detected**. Informational findings have no penalty, and unsupported or unresolved behavior may still hide risks. Complete source coverage records which eligible files and checks were analyzed; it does not verify runtime capacity, deployment topology, or safety of categories with no findings.

## Precision

Local identity resolution follows relative imports, named/default/star re-exports, namespace imports and common CommonJS exports among analyzed files. TypeScript `baseUrl`/`paths`, nested JSONC configs and repository-local relative `extends` are supported. Resolution never loads target packages or external configs; computed imports, package exports maps and external config packages can require manual review.

Synchronous I/O findings use conservative module reachability: CLI entry points (Node shebangs or package bins) and explicit Node child-process/worker-thread URL launches propagate their context through local runtime imports. Calls reachable only from these entries are informational; a request entry reaching the same helper takes precedence. Request paths, common route/server registrations, and request/response callback signatures provide request evidence. Type-only imports do not execute and do not propagate context. This is static evidence from the analyzed files, not proof of every runtime call path; external consumers and dynamically computed imports can limit classification.

A linter that cries wolf gets uninstalled, so every finding is grounded in evidence:

- A capitalised receiver is only treated as a database model when there is proof — it is bound to a model factory, imported from an entity/model path, or present in a Prisma schema. `UserService.find()` is not a database read.
- Scalar counts and Prisma aggregate objects are treated as bounded. Grouped results and aggregation pipelines still need a cap; offsets and cursors alone do not cap result counts. Pagination uses the final effective option or chained cap and does not treat MongoDB/Mongoose filter fields as options.
- A module-level `Map`/`Set` that is only filled at import time is a constant, not runtime state.
- Pool lifetime checks recognize guarded initialization of shared module bindings and classes constructed inside functions across local imports and re-exports. A guard that yields before initialization is still reported. Registered Nest providers track default singleton, request and transient lifetimes, constructor/token injection, and request-scope propagation. Singleton factories stay quiet; unresolved scopes and transient per-consumer allocations are informational. Static Nest dynamic-module returns and known provider-array spreads are followed without executing registration methods. Awilix registrations, Inversify binding chains, and TSyringe decorators/registrations track shared roots, child scopes, aliases, and visible constructor dependencies through local imports. Handler resolution distinguishes transient/per-resolution lifetimes from cached singletons and container-scoped instances; Inversify request scope means one resolution plan. Nest token lookup respects module providers, imports, exports and visible global modules. Private, unreferenced setup functions do not replace live registrations, and uncertain configuration paths do not prove singleton reuse. Factory helper memoization includes every known container argument; Inversify constructor type injection follows the analyzed compiler metadata settings. Class construction sites are indexed once under a work budget. Ordinary container resolution uses the active registration and Inversify name/tag constraints; bulk resolution retains multiple bindings. Singleton lifetime accounts for registration frequency, including per-request registrations and recognized once-only guards. Factory lifetimes follow visible helper calls and nested resolutions, including TSyringe array injection and zero-argument class fallback, Nest property injection, and Awilix build resolvers. Known registration spreads, shorthand properties, chained container registration, property injection, Awilix CLASSIC/proxy dependencies, and constant token aliases are supported. Request evidence follows named and exported-arrow handlers, Fastify route objects, visible array callbacks, and called local helpers, while startup scopes and static class initialization are kept separate from instance construction. Static metadata keeps spread override order and alternative module returns. Expression depth, metadata expansion, map operations, export reachability and lifetime traversal have work limits; exceeding a budget fails the audit explicitly rather than silently omitting findings. Arbitrary runtime-generated registrations, registration arguments computed by executing functions, container mutation, and computed tokens still require manual review. Known database factories such as `createPool()` are checked alongside constructors; unrelated local `Client` classes are ignored.
- Query-builder methods (`select`, `from`, `where`) are not reads on their own; only the completed chain is.
- GraphQL/SDK clients (`client.query({ query })`) are not mistaken for raw SQL.
- Locally shadowed `fetch`/`axios` bindings and Axios utility exports are excluded from HTTP findings and timeout fixes; supported ESM/CommonJS import aliases retain their identity. Native `globalThis.fetch` and `undici.fetch` are also recognized.
- Raw SQL checks evaluate each statement separately, ignore comments, quoted values and subquery-only limits, and distinguish scalar aggregates and non-returning writes from row reads. SQL analysis is conservative and is not a full dialect parser.
- Missing-index checks descend into logical groups and known scalar filter operators while leaving relation subtrees separate. Deferred function declarations inside loops do not count as executed N+1 queries. Bare rejected promises and ineffective `.catch()` handlers are reported.
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
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
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

- Local-preview defaults: binds `127.0.0.1`, restricts remote inputs to **github.com repository URLs**, requires JSON, validates Host/Origin, and limits request bodies to 10,000 bytes.
- Audits run in killable child processes with a 120-second deadline, a 512 MB V8 heap limit, a 2 MB report limit, and no inherited Git credentials/configuration. These are not OS-level sandbox, total-RSS, or clone-disk quotas.
- At most 200 jobs are retained, with 2 audits running concurrently; completed reports expire after 15 minutes and responses use `Cache-Control: no-store`.
- For local development on a local folder: `SCALE_AUDIT_ALLOW_LOCAL=1 npm run serve`. This lets local clients request audits of readable local folders; do not expose this mode to other users.
- Report UUIDs are bearer links, not authenticated accounts. Keep the preview local; public hosting still needs authentication, OS/container isolation and disk/network quotas.

## Safety

- Never executes target code; static readers only.
- CLI clones are deleted after analysis; web audit temporary directories are also cleaned up on failure, timeout and shutdown.
- Repository readers reject path traversal, symlinked files/ancestors, non-regular files and files over 1 MB. Aggregate input limits are 20 MB of source, 10 MB of Prisma schemas and 5 MB of manifests; traversal and file-count limits fail the audit explicitly.
- Individual unsafe or oversized files are skipped, so a clean report is not proof that every repository file was analyzed.
- Test/examples/docs folders are skipped for detector noise.
- `--fix` is opt-in and only ever touches a local path you passed in.

## Development

```bash
npm ci
npm test
npm run build
```

Requires Node.js `^22.23.4 || ^24.22.1 || >=26.12.1` (Oct 2026 security patches). Node 20 is EOL and unsupported. The CLI and server reject unsupported runtime versions at startup; `.npmrc` also enforces engines for contributors. CI selects the newest available patch within supported release ranges. Self-hosted GitHub Actions runners must support the current Node 24-based Actions.

### Audit completeness and work limits

JSON reports include `complete` and per-detector `detectors` statuses. Detector failures retain findings from successful checks and mark the report incomplete. Markdown and HTML display an incomplete-audit warning; scores then describe successful checks only. Incomplete audits never apply `--fix` edits.

CLI exit codes: **0** complete, **1** fatal/input error, **2** `--fail-on` threshold reached, **3** incomplete audit (takes precedence over 2). Reports are written before exit 3, including the GitHub Action PR report. HTTP audits retain incomplete reports with the same structured status and visible warning.

Whole-project analysis budgets scale with file count and AST size, up to a fixed ceiling. Local static-evaluation and depth limits, filesystem safety checks, aggregate input caps, and worker memory/time/report caps remain unchanged. Failures before a workspace can be loaded, including aggregate input-limit violations, remain fatal errors; no usable detector results exist at that stage.

Startup promise completion follows immutable aliases and statically selected logical/comma values at their return or await site. Completion cannot protect earlier listeners or discarded promises. Invariant collection aliases reuse cached resolution while retaining their original depth checks; failed mutation/escape scans never publish partial facts. A failed startup analysis context retains its failure on retry, including after exhaustion during lazy result iteration.

BOM-marked UTF-16LE and UTF-16BE sources are decoded for auditing; UTF-8 (including BOM) remains supported. File limits still apply to bytes read from the descriptor. UTF-16 automated patches are left for manual repair; `--fix` never rewrites them as UTF-8.

For local troubleshooting, `--debug` writes original detector exceptions and stacks to stderr. JSON/Markdown/HTML reports retain sanitized errors; HTTP workers do not enable diagnostics. Debug output can contain private paths or source details, so inspect it before sharing. Analysis-limit failures expose typed, actionable reasons even without debugging.

Cross-file binding-depth exhaustion marks affected detectors incomplete; genuine import cycles remain unresolved identities. Local module resolution tries direct source files before directory indexes and uses TypeScript-style extension substitution.

DI analysis preserves conditional registration alternatives, ignores statically dead branches, and follows inherited Nest injection metadata. Mutable conditions cannot prove singleton reuse. TSyringe constructor-type inference requires an analyzed config with `emitDecoratorMetadata: true`; missing or disabled metadata is uncertain, while explicit injection tokens are still followed.

Precision checks distinguish imported Node HTTP APIs from shadowed local names, require native timer-signal identity for timeout proof, and avoid concurrency warnings for proven synchronous projections. Destructured results count as dependencies between awaited calls. SQL percentage caps and branch-local caps cannot establish a bound for an entire result set. These checks remain static heuristics, not execution or full framework/SQL semantic analysis.

### 0.3.9 — remaining limits

Startup completion through native promise combinators such as `Promise.resolve(install())` remains conservative and can produce a missing-setup warning even when the wrapper is awaited.

Startup method identity requires a receiver with no visible mutation or escape. Exported or escaped receivers, accessors, spreads, and methods using `this` remain conservative when proving helper execution or async return values.

Class prototype mutations follow visible constructor and prototype aliases, including known instance constructor paths. Caught import rejection preserves independently reached parent setup; failed helper completions retain their own import prerequisites, and pending imports cannot resume through a catch.

Awaited dynamic-import cycles cannot establish completed setup; ordinary static cycles and dependencies that have already completed remain supported. Visible throws from local CommonJS dependencies stop subsequent helper setup while preserving reached prefixes. CommonJS paths available only through runtime helper arguments remain conservative when dependency ordering cannot be established.

Async property initializers are checked by declaration identity and visible writes in the declaration source. Property mutations in other files require manual review. Subclass overrides of an inherited method's `this` property are not resolved by runtime instance type, so this pattern can still produce a false positive and needs manual review.

Concurrency checks inspect executed callback work, including calls whose results are discarded. Known synchronous built-ins and inspectable synchronous helpers can stay quiet; unknown external calls and overridable untyped methods such as `x.toString()` remain conservative candidates. Primitive receiver annotations are static evidence, not runtime validation.

Deferred operational changes: the 20 MB aggregate source cap remains fatal before workspace analysis; it does not produce a partial report. Any skipped source file still marks an audit incomplete and returns CLI exit 3 by default, including in the GitHub Action. These strict behaviors are unchanged in 0.3.9. SQL bounds remain conservative; an outer query reading only a bounded CTE may still be reported as unbounded.
