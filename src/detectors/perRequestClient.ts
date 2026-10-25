import { AnalysisBudget } from "../analysisBudget.js";
import { executionLifetimes } from "../executionLifetimes.js";
import { requestEvidence } from "../requestEvidence.js";
import { containerLifetimes } from "../containerLifetimes.js";
import { providerLifetimes, type ProviderLifetime } from "../lifetimes.js";
import { definitionOf, importedBinding, projectFor, symbolOf } from "../bindings.js";
import ts from "typescript";
import { lineOf, snippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";
import { Workspace } from "../workspace.js";
import { executionContexts } from "../executionContext.js";
import { isRequestPath } from "./syncIo.js";

/**
 * Clients created per request.
 *
 * `new PrismaClient()` inside a request handler creates a brand new connection
 * pool on every request. PostgreSQL's default `max_connections` is 100, so a
 * modest amount of traffic exhausts the connection pool and every request starts
 * failing. This is invisible in development (one user, one request) and is one
 * of the most common causes of "it worked yesterday and now everything times out".
 */
const CLIENT_CONSTRUCTORS = new Set([
  "PrismaClient",
  "Pool",
  "Client",
  "Redis",
  "RedisClient",
  "ioredis",
  "MongoClient",
  "Sequelize",
  "DataSource",
  "Knex",
  "createPool",
  "createClient",
  "createConnection",
]);

export async function detectPerRequestClients(root: string, ws?: Workspace): Promise<Finding[]> {
  const out: Finding[] = [];
  const workspace = ws ?? (await Workspace.load(root));

  const request = requestEvidence(workspace);
  let lifetimes = providerLifetimes(workspace);
  const rank = { singleton: 0, transient: 1, unknown: 2, request: 3 };
  for (const [owner, lifetime] of containerLifetimes(workspace)) {
    const previous = lifetimes.get(owner);
    if (!previous || rank[lifetime.kind] > rank[previous.kind]) lifetimes.set(owner, lifetime);
  }
  lifetimes = executionLifetimes(workspace, lifetimes);
  const contexts = await executionContexts(root, workspace, isRequestPath);
  for (const { rel, content, sf } of workspace.units) {
    const requestPath = contexts.get(rel)?.request ?? isRequestPath(rel);
    visit(sf, sf, content, rel, requestPath, out, lifetimes, request);
  }
  return out;
}

function visit(node: ts.Node, sf: ts.SourceFile, content: string, rel: string, requestPath: boolean, out: Finding[], lifetimes: Map<ts.Node, ProviderLifetime>, request: (node: ts.Node) => boolean): void {
  if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
    const name = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.getText() : "";
    const imported = importedBinding(ts.isPropertyAccessExpression(node.expression) ? node.expression.expression : node.expression);
    const declaration = definitionOf(node.expression);
    const knownPackage = imported && /^(?:@prisma\/client|pg|mysql2(?:\/promise)?|mysql|redis|ioredis|mongodb|sequelize|typeorm|knex)$/.test(imported.module);
    const localClass = declaration && (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration) || ts.isFunctionDeclaration(declaration));
    const defaultName = imported?.name === "default" ? ({ ioredis: "Redis", sequelize: "Sequelize", knex: "Knex" } as Record<string, string>)[imported.module] : undefined;
    const actualName = defaultName ?? (imported && imported.name !== "default" && imported.name !== "*" ? imported.name : name);
    if (CLIENT_CONSTRUCTORS.has(actualName) && !localClass && (knownPackage || (!imported && !declaration && ts.isNewExpression(node)))) {
      const staticOwner = staticAllocationOwner(node);
      const staticField = !!staticOwner && !request(staticOwner);
      const repeatedClass = !!staticOwner && request(staticOwner) || !staticField && classConstructedPerCall(node, lifetimes);
      const lifetime = staticField ? { kind: "singleton" as const } : repeatedClass ? undefined : allocationLifetime(node, lifetimes);
      const perRequest = lifetime?.kind === "request" || lifetime?.requestConsumer;
      const transient = lifetime?.kind === "transient" && !lifetime.requestConsumer;
      const uncertain = lifetime?.kind === "unknown";
      const insideFunction = isInsideFunction(node) || repeatedClass;
      if ((insideFunction || perRequest || transient || uncertain) && (perRequest || transient || uncertain || ((repeatedClass || !isSingletonPattern(node, lifetimes)) && lifetime?.kind !== "singleton"))) {
        const ln = lineOf(sf, node);
        out.push(
          makeFinding({
            id: uncertain ? "unknown-provider-lifetime" : transient ? "transient-client-lifetime" : "per-request-client",
            category: "Connection",
            severity: transient || uncertain ? "info" : perRequest || requestPath ? "high" : "medium",
            confidence: transient || uncertain ? "low" : perRequest || requestPath ? "medium" : "low",
            file: rel,
            line: ln,
            message: uncertain ? "Provider lifetime could not be resolved from static metadata; verify whether its client is shared." : transient ? "Client allocated by a transient provider: instances are per consumer, not automatically per request."
              : perRequest ? "Client allocated by a provider resolved anew by a request handler or request scope; its connections are recreated."
              : `"${ts.isNewExpression(node) ? "new " : ""}${name}()" is created inside a function; each call opens a new connection pool.`,
            scaleTrigger:
              uncertain ? "Dynamic provider metadata can select singleton, transient or request lifetime." : transient ? "Connection count depends on consumer lifetimes; verify how many consumers resolve this provider." : "Every request opens fresh database/Redis connections. Postgres defaults to 100 connections, so traffic exhausts the pool and requests start timing out.",
            suggestedFix: uncertain ? "Review the provider registration and scope before changing client initialization." : transient ? "Prefer a shared connection provider when appropriate; inspect consumer scope before changing this lifetime." : "Create the client once at module scope and reuse it, or inject it as a singleton.",
            snippet: snippetAt(content, ln),
          }),
        );
      }
    }
  }
  ts.forEachChild(node, (c) => visit(c, sf, content, rel, requestPath, out, lifetimes, request));
}

/**
 * True when the client is created once and reused.
 *
 * A dependency-injection container constructs a service once per application,
 * and class field initializers run during construction. Assignment in an
 * ordinary method alone does not establish singleton reuse.
 */
function isSingletonPattern(node: ts.Node, lifetimes: Map<ts.Node, ProviderLifetime>): boolean {
  if (guardedSharedInitialization(node)) return true;
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isConstructorDeclaration(current) || ts.isPropertyDeclaration(current)) return !classConstructedPerCall(node, lifetimes);
    // An ordinary method or callback executes independently of construction.
    if (ts.isFunctionLike(current)) return false;
    current = current.parent;
  }
  return false;
}

function isInsideFunction(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isGetAccessorDeclaration(cur) ||
      ts.isSetAccessorDeclaration(cur) ||
      ts.isConstructorDeclaration(cur)
    ) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

/** Suppress only guards on a shared module binding, not a fresh request local. */
function guardedSharedInitialization(node: ts.Node): boolean {
  const assignment = node.parent;
  if (!ts.isBinaryExpression(assignment) || !ts.isIdentifier(assignment.left)) return false;
  const binding = symbolOf(assignment.left);
  const declaration = binding?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || isInsideFunction(declaration)) return false;
  if ([ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken].includes(assignment.operatorToken.kind)) return true;
  if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  const sameBinding = (value: ts.Expression) => ts.isIdentifier(value) && symbolOf(value) === binding;
  let current: ts.Node | undefined = assignment.parent;
  while (current && !ts.isFunctionLike(current)) {
    if (ts.isIfStatement(current)) {
      const condition = current.expression;
      const guarded = (ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken && sameBinding(condition.operand))
        || (ts.isBinaryExpression(condition) && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(condition.operatorToken.kind)
          && sameBinding(condition.left) && (condition.right.kind === ts.SyntaxKind.NullKeyword || condition.right.getText() === "undefined"));
      // An else branch is not guarded by the condition's falsy test.
      let branch: ts.Node = assignment;
      while (branch.parent !== current && branch.parent) branch = branch.parent;
      if (guarded && branch === current.thenStatement) {
        let yieldsBeforeInitialization = false;
        const inspect = (part: ts.Node) => {
          if (ts.isFunctionLike(part)) return;
          if (ts.isAwaitExpression(part) && part.getStart() < node.getStart()) yieldsBeforeInitialization = true;
          ts.forEachChild(part, inspect);
        };
        inspect(current.thenStatement);
        if (!yieldsBeforeInitialization) return true;
      }
    }
    current = current.parent;
  }
  return false;
}

/** Constructor/field initialization is per-call when the owning class is new'd
 * in a function. Class identities are followed through local imports and re-exports. */
const constructionIndices = new WeakMap<object, Map<ts.Node, ts.NewExpression[]>>();
const repeatedConstruction = new WeakMap<Map<ts.Node, ProviderLifetime>, WeakMap<ts.Node, boolean>>();
function classConstructedPerCall(node: ts.Node, lifetimes: Map<ts.Node, ProviderLifetime>): boolean {
  let owner: ts.Node | undefined = node.parent;
  while (owner && !ts.isClassDeclaration(owner) && !ts.isClassExpression(owner)) owner = owner.parent;
  if (!owner || (!ts.isClassDeclaration(owner) && !ts.isClassExpression(owner)) || !owner.name) return false;
  const known = repeatedConstruction.get(lifetimes) ?? new WeakMap<ts.Node, boolean>();
  repeatedConstruction.set(lifetimes, known);
  const cached = known.get(owner); if (cached !== undefined) return cached;
  const project = projectFor(node.getSourceFile()), context = project ?? node.getSourceFile();
  let index = constructionIndices.get(context);
  if (!index) {
    index = new Map();
    const budget = new AnalysisBudget("Class construction index", 200_000);
    const pending: ts.Node[] = [...(project?.sources.values() ?? [node.getSourceFile()])];
    while (pending.length) {
      budget.take(); const candidate = pending.pop()!;
      if (ts.isNewExpression(candidate)) {
        const target = definitionOf(candidate.expression);
        if (target) { const entries = index.get(target) ?? []; entries.push(candidate); index.set(target, entries); }
      }
      ts.forEachChild(candidate, child => { pending.push(child); });
    }
    constructionIndices.set(context, index);
  }
  const budget = new AnalysisBudget("Class construction references");
  let repeated = false;
  for (const candidate of index.get(owner) ?? []) {
    budget.take();
    if (isInsideFunction(candidate) && allocationLifetime(candidate, lifetimes)?.kind !== "singleton" && !guardedSharedInitialization(candidate)) { repeated = true; break; }
  }
  known.set(owner, repeated); return repeated;
}

function allocationLifetime(node: ts.Node, lifetimes: Map<ts.Node, ProviderLifetime>): ProviderLifetime | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    const lifetime = lifetimes.get(current);
    if (lifetime) return lifetime;
    // Provider scope controls construction/factory execution, not arbitrary methods.
    if (ts.isMethodDeclaration(current) || ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current)) return undefined;
    if (ts.isFunctionLike(current) && !ts.isConstructorDeclaration(current)) return undefined;
    current = current.parent;
  }
  return undefined;
}

/** Static fields/blocks run on class evaluation, not on each DI construction. */
function staticAllocationOwner(node: ts.Node): ts.Node | undefined {
  let staticMember = false;
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isPropertyDeclaration(current)) staticMember = !!ts.getModifiers(current)?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword);
    if (ts.isClassStaticBlockDeclaration(current)) staticMember = true;
    if (ts.isFunctionLike(current)) return undefined;
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) return staticMember ? current : undefined;
  }
  return undefined;
}
