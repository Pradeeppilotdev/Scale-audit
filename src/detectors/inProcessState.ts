import { isRecord, parseRepoManifest, readRepoFile } from "../repoFiles.js";
import ts from "typescript";
import { currentImportedBinding as importedValueAtUse, currentImportedMember, isCommonJsRequire, projectFor, symbolOf } from "../bindings.js";
import { currentInitializer } from "../signals.js";
import { AnalysisLimitError } from "../analysisBudget.js";
import { lineOf, locationOf, sourceSnippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";
import type { FileContext } from "../context.js";
import { Workspace } from "../workspace.js";

export async function detectInProcessState(root: string, ws?: Workspace): Promise<Finding[]> {
  const out: Finding[] = [];
  const workspace = ws ?? (await Workspace.load(root));

  const pkg = parseRepoManifest(await readRepoFile(root, "package.json"));
  const deps = {
    ...(isRecord(pkg.dependencies) ? pkg.dependencies : {}),
    ...(isRecord(pkg.devDependencies) ? pkg.devDependencies : {}),
  };

  for (const unit of workspace.units) {
    const { rel, sf, ctx } = unit;

    visitSession(sf, rel, ctx, out);
    visitRateLimit(sf, rel, ctx, out);
    visitSocketIo(sf, rel, deps, out);
    detectModuleScopeState(sf, rel, out);
  }
  return out;
}

/**
 * How confident we are that a middleware options object has no shared store.
 * "none" = the options object is visible and has no `store` key.
 * "unknown" = the options live in a variable, so we cannot tell.
 */
type StoreVerdict = "none" | "unknown" | "present";

function storeVerdict(arg: ts.Expression | undefined): StoreVerdict {
  if (!arg) return "none";
  const val = unwrap(arg);
  if (!ts.isObjectLiteralExpression(val)) return "unknown";
  let verdict: StoreVerdict = "none";
  for (const property of val.properties) {
    if (ts.isSpreadAssignment(property) || property.name && ts.isComputedPropertyName(property.name)) {
      verdict = "unknown";
      continue;
    }
    const name = property.name && property.name.getText().replace(/['"]/g, "");
    if (name !== "store") continue;
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) { verdict = "unknown"; continue; }
    const value = unwrap(ts.isPropertyAssignment(property) ? property.initializer : property.name);
    const absent = value.kind === ts.SyntaxKind.NullKeyword || value.kind === ts.SyntaxKind.FalseKeyword
      || ts.isVoidExpression(value) || ts.isNumericLiteral(value) && Number(value.text) === 0
      || ts.isStringLiteralLike(value) && value.text === ""
      || ts.isIdentifier(value) && value.text === "undefined" && !symbolOf(value)?.declarations?.length;
    verdict = absent ? "none" : "present";
  }
  return verdict;
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression) || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression;
  return expression;
}

const SESSION_MODULES = new Set(["express-session", "fastify-session", "@fastify/session"]);
const RATE_LIMIT_MODULES = new Set(["express-rate-limit", "rate-limiter-flexible", "fastify-rate-limit", "@fastify/rate-limit", "koa-ratelimit"]);
const NAMED_MIDDLEWARE_FACTORIES = new Map([
  ["fastify-session", "fastifySession"], ["@fastify/session", "fastifySession"],
  ["express-rate-limit", "rateLimit"],
  ["fastify-rate-limit", "fastifyRateLimit"], ["@fastify/rate-limit", "fastifyRateLimit"],
]);

function isMiddlewareImport(binding: { module: string; name: string }, modules: ReadonlySet<string>): boolean {
  return modules.has(binding.module) && (binding.name === "default" || binding.name === "*"
    || NAMED_MIDDLEWARE_FACTORIES.get(binding.module) === binding.name);
}

interface CurrentImportSummary {
  binding?: { module: string; name: string };
  depth: number;
  project: ReturnType<typeof projectFor>;
}
const currentImportSummaries = new WeakMap<ts.Expression, CurrentImportSummary>();

/** Follow captured aliases only while their initializer is still current.
 * Shared suffixes retain their depth, including unknown/cyclic origins, so
 * cached lookups neither replay the alias chain nor bypass its depth limit. */
function currentImportedBinding(expression: ts.Expression): { module: string; name: string } | undefined {
  let current = unwrap(expression);
  const project = projectFor(current.getSourceFile());
  const seen = new Map<ts.Expression, number>();
  const path: { node: ts.Expression; property?: string }[] = [];
  let result: CurrentImportSummary;
  for (;;) {
    const cycle = seen.get(current);
    if (cycle !== undefined) {
      result = { depth: path.length - cycle, project };
      for (let index = cycle; index < path.length; index++) currentImportSummaries.set(path[index].node, result);
      path.length = cycle;
      break;
    }
    const cached = currentImportSummaries.get(current);
    if (cached && cached.project === project) {
      if (path.length + cached.depth > 129) throw new AnalysisLimitError("Binding resolution depth limit exceeded");
      result = cached;
      break;
    }
    if (path.length > 128) throw new AnalysisLimitError("Binding resolution depth limit exceeded");
    seen.set(current, path.length);
    if (ts.isPropertyAccessExpression(current)) {
      path.push({ node: current, property: current.name.text });
      current = unwrap(current.expression);
      continue;
    }
    if (ts.isIdentifier(current)) {
      const declaration = symbolOf(current)?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration)) {
        const value = currentInitializer(declaration, current);
        if (value) {
          path.push({ node: current });
          current = unwrap(value);
          continue;
        }
        result = { depth: 1, project };
        currentImportSummaries.set(current, result);
        break;
      }
    }
    let binding = importedValueAtUse(current) ?? undefined;
    if (!binding && ts.isCallExpression(current) && isCommonJsRequire(current.expression)
      && current.arguments[0] && ts.isStringLiteral(current.arguments[0])) {
      binding = { module: current.arguments[0].text, name: "*" };
    }
    result = { binding, depth: 1, project };
    currentImportSummaries.set(current, result);
    break;
  }
  for (let index = path.length - 1; index >= 0; index--) {
    const { node, property } = path[index];
    let binding = result.binding;
    if (property && binding) binding = currentImportedMember(binding, property, node) ?? undefined;
    result = { binding, depth: result.depth + 1, project };
    currentImportSummaries.set(node, result);
  }
  return result.binding;
}

/** Bindings distinguish middleware imports from same-named application code. */
function middlewareBinding(expression: ts.Expression, modules: ReadonlySet<string>, names: ReadonlySet<string>): boolean {
  const callee = unwrap(expression);
  const imported = currentImportedBinding(callee);
  if (imported) return isMiddlewareImport(imported, modules);
  return ts.isIdentifier(callee) && names.has(callee.text) && !symbolOf(callee)?.declarations?.length;
}

function visitSession(sf: ts.SourceFile, rel: string, ctx: FileContext, out: Finding[]) {
  const names = new Set(["session", "expressSession", ...ctx.sessionBindings]);
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const isSession = middlewareBinding(node.expression, SESSION_MODULES, names);
      if (isSession) {
        const verdict = storeVerdict(node.arguments[0]);
        if (verdict === "none") {
          const { line, column } = locationOf(sf, node);
          out.push(
            makeFinding({
              id: "in-process-session",
              category: "Concurrency",
              severity: "high",
              confidence: "medium",
              file: rel,
              line, column,
              message: "express-session configured without a `store` (defaults to in-memory MemoryStore).",
              scaleTrigger: "Sessions not shared across instances; MemoryStore is not production-safe for clusters.",
              suggestedFix: "Configure a shared session store (Redis/DB) via connect-redis or equivalent.",
              snippet: sourceSnippetAt(sf, line),
            }),
          );
        } else if (verdict === "unknown") {
          const { line, column } = locationOf(sf, node);
          out.push(
            makeFinding({
              id: "in-process-session",
              category: "Concurrency",
              severity: "low",
              confidence: "low",
              file: rel,
              line, column,
              message: "express-session options are passed as a variable; could not confirm a shared `store` is configured.",
              scaleTrigger: "Without a shared store, sessions live in per-instance memory and are lost on restart.",
              suggestedFix: "Verify the options object sets `store` (Redis/DB); the default is the in-memory MemoryStore.",
              snippet: sourceSnippetAt(sf, line),
            }),
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

function visitRateLimit(sf: ts.SourceFile, rel: string, ctx: FileContext, out: Finding[]) {
  const names = new Set(["rateLimit", ...ctx.rateLimitBindings]);
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const isRateLimit = middlewareBinding(node.expression, RATE_LIMIT_MODULES, names);
      if (isRateLimit) {
        const verdict = storeVerdict(node.arguments[0]);
        if (verdict === "none") {
          const { line, column } = locationOf(sf, node);
          out.push(
            makeFinding({
              id: "in-memory-rate-limit",
              category: "Concurrency",
              severity: "medium",
              confidence: "medium",
              file: rel,
              line, column,
              message: "rate limit middleware configured without a shared `store` (uses in-memory by default).",
              scaleTrigger: "Rate limits reset per instance and can be bypassed behind a load balancer.",
              suggestedFix: "Configure a shared store (Redis) if running more than one instance; otherwise document the single-instance constraint.",
              snippet: sourceSnippetAt(sf, line),
            }),
          );
        } else if (verdict === "unknown") {
          const { line, column } = locationOf(sf, node);
          out.push(
            makeFinding({
              id: "in-memory-rate-limit",
              category: "Concurrency",
              severity: "low",
              confidence: "low",
              file: rel,
              line, column,
              message: "rate limit options are passed as a variable; could not confirm a shared `store` is configured.",
              scaleTrigger: "An in-memory limiter resets per instance and can be bypassed behind a load balancer.",
              suggestedFix: "Verify the options object sets `store` (Redis) when running more than one instance.",
              snippet: sourceSnippetAt(sf, line),
            }),
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

function visitSocketIo(sf: ts.SourceFile, rel: string, deps: Record<string, unknown>, out: Finding[]) {
  if (deps["@socket.io/redis-adapter"] || deps["socket.io-redis"]) return;
  let line: number | null = null;
  function visit(node: ts.Node) {
    if (line) return;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const binding = currentImportedBinding(node.expression);
      if (binding?.module === "socket.io" && ["Server", "default", "*"].includes(binding.name)) line = lineOf(sf, node);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  if (!line) return;
  out.push(
    makeFinding({
      id: "in-memory-websocket",
      category: "Concurrency",
      severity: "medium",
      confidence: "medium",
      file: rel,
      line,
      message: "WebSocket server uses in-process state (no Redis adapter detected).",
      scaleTrigger: "Broadcasts/rooms do not propagate across instances.",
      suggestedFix: "Use @socket.io/redis-adapter (or sticky sessions + shared pub/sub) for horizontal scaling.",
      snippet: sourceSnippetAt(sf, line),
    }),
  );
}

/**
 * Module-level in-memory collections.
 *
 * A module-level `new Map()` that is only filled at import time is a constant
 * lookup table, not runtime state, so it is not reported. Only collections that
 * are mutated while the process is serving requests qualify.
 */
function detectModuleScopeState(sf: ts.SourceFile, rel: string, out: Finding[]) {
  const mutations = runtimeCollectionMutations(sf);
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer) continue;
      if (!ts.isIdentifier(decl.name)) continue;
      const init = unwrap(decl.initializer);
      if (!ts.isNewExpression(init) || !ts.isIdentifier(init.expression) || !["Map", "Set"].includes(init.expression.text)
        || symbolOf(init.expression)?.declarations?.length) continue;
      const name = decl.name.getText().toLowerCase();
      if (!/(cache|session|state|store|rate|limit|book|registry|tokens)/.test(name)) continue;
      const binding = symbolOf(decl.name);
      if (!binding || !mutations.has(binding)) continue;
      const { line, column } = locationOf(sf, decl);
      out.push(
        makeFinding({
          id: "in-process-state",
          category: "Concurrency",
          severity: "medium",
          confidence: "low",
          file: rel,
          line, column,
          message: `Module-level in-memory collection "${decl.name.getText()}" used as state/cache.`,
          scaleTrigger: "State is not shared across instances/processes, and the collection grows without bound.",
          suggestedFix: "Move state to Redis/shared cache, or make the resource stateless.",
          snippet: sourceSnippetAt(sf, line),
        }),
      );
    }
  }
}

/** Index declaration identities once, rather than scanning per collection. */
function runtimeCollectionMutations(sf: ts.SourceFile): Set<ts.Symbol> {
  const mutations = new Set<ts.Symbol>();
  const pending: { node: ts.Node; inside: boolean }[] = [{ node: sf, inside: false }];
  while (pending.length) {
    const current = pending.pop()!;
    const { node } = current;
    const inside = current.inside || ts.isFunctionLike(node);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = unwrap(node.expression.expression);
      const method = node.expression.name.getText();
      if (inside && ts.isIdentifier(receiver) && ["set", "add", "push", "delete", "clear"].includes(method)) {
        const binding = symbolOf(receiver);
        const declaration = binding?.valueDeclaration;
        if (binding && declaration && ts.isVariableDeclaration(declaration)
          && currentInitializer(declaration, receiver) === declaration.initializer) mutations.add(binding);
      }
    }
    ts.forEachChild(node, child => { pending.push({ node: child, inside }); });
  }
  return mutations;
}
