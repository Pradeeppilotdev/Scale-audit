import path from "node:path";
import ts from "typescript";
import { checkerFor, definitionOf, importedBinding, projectFor, symbolOf } from "./bindings.js";
import { AnalysisBudget, AnalysisLimitError, projectWorkLimit } from "./analysisBudget.js";
import { isRecord, parseRepoManifest, readRepoFile, RepoInputBudget, MAX_MANIFEST_BYTES } from "./repoFiles.js";
import type { SourceUnit, Workspace } from "./workspace.js";

interface Environment extends Map<ts.Declaration, ts.Expression | undefined> {
  /** Active helper allocation scopes, retained when argument bindings are copied. */
  scopes?: ReadonlyMap<ts.FunctionLikeDeclaration, string>;
}
function copyEnvironment(env: Environment): Environment {
  const copy: Environment = new Map(env);
  copy.scopes = env.scopes;
  return copy;
}
function containingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) if (ts.isFunctionLike(parent)) return parent as ts.FunctionLikeDeclaration;
  return undefined;
}
function allocationScope(node: ts.Node, env?: Environment): string | undefined {
  const fn = containingFunction(node);
  return fn ? env?.scopes?.get(fn) : "module";
}
export interface StartupContext {
  /** Calls reached on an unconditional startup path; only these establish protection. */
  calls: ReadonlySet<ts.CallExpression>;
  /** Definite calls consumable as lifecycle/process protection evidence. */
  protectiveCalls: ReadonlySet<ts.CallExpression>;
  /** Includes conditional calls, so uncertain startup does not conceal a server. */
  possibleCalls: ReadonlySet<ts.CallExpression>;
  /** Syntax-filtered listener candidates, indexed once per shared summary. */
  possibleListeners: ReadonlySet<ts.CallExpression>;
  invocationsFor(call: ts.Node, protective?: boolean): readonly StartupContext[];
  allocationScope(node: ts.Node, site?: ts.Node): string | undefined;
  sources: Set<ts.SourceFile>;
  protectionCallsFor(listener: ts.CallExpression): ReadonlySet<ts.CallExpression>;
  resolveExpression(node: ts.Expression, call?: ts.Node): ts.Expression | undefined;
}
interface Invocation { env: Environment; definite: boolean }
type ProofBindings = Map<ts.Node, Map<Environment, Invocation>>;
interface ReturnAdoption { summary?: Summary; definite: boolean; rejects?: boolean; stalls?: boolean }
interface Summary {
  mayAbort: boolean;
  mayStall: boolean;
  calls: Set<ts.CallExpression>;
  possibleCalls: Set<ts.CallExpression>;
  imports: Map<ts.SourceFile, boolean>;
  bindings: Map<ts.Node, Invocation[]>;
  bindingIndex: Map<ts.Node, Map<string, Invocation>>;
}
interface Flow { normal: boolean; mayExit: boolean; thrown?: boolean; returned?: boolean; suspended?: boolean }
/** Internal scheduling signal, handled before it can become an audit failure. */
class RequiredSourcePending { constructor(readonly source: ts.SourceFile) {} }
const NORMAL: Flow = { normal: true, mayExit: false };
const EXIT: Flow = { normal: false, mayExit: true };
const PROTECTIVE_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "use", "route", "head", "options", "on", "once", "addListener", "enableShutdownHooks"]);
const PROTECTION_EVENTS = new Set(["SIGTERM", "SIGINT", "unhandledRejection"]);
const PROTECTION_PATH = /^\/(?:api\/)?(health|healthz|live|ready|readiness)(?:\/|$)/i;
const protectionCandidates = new WeakMap<ts.CallExpression, boolean>();
// Keep the traversed depth with each result: reusing a suffix must not let a
// longer alias chain bypass the same argument-depth limit.
const protectionArguments = new WeakMap<ts.Expression, { value: ts.Expression; depth: number }>();
/** Resolve only source-invariant literals. Parameters and runtime expressions
 * stay candidates; their invocation bindings are evaluated by the consumers. */
function protectionArgument(node: ts.Expression | undefined, budget?: AnalysisBudget): ts.Expression | undefined {
  const seen = new Set<ts.Node>();
  const path: ts.Expression[] = [];
  const remember = (value: ts.Expression, suffixDepth = 0): ts.Expression => {
    for (let index = 0; index < path.length; index++) {
      budget?.take();
      protectionArguments.set(path[index], { value, depth: path.length - index + suffixDepth });
    }
    return value;
  };
  while (node && !seen.has(node)) {
    budget?.take();
    if (seen.size > 64) throw new AnalysisLimitError("Startup argument depth limit exceeded");
    const cached = protectionArguments.get(node);
    if (cached) {
      if (seen.size + cached.depth > 65) throw new AnalysisLimitError("Startup argument depth limit exceeded");
      return remember(cached.value, cached.depth);
    }
    seen.add(node);
    path.push(node);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
      node = node.expression; continue;
    }
    const declaration = ts.isIdentifier(node) ? symbolOf(node)?.valueDeclaration : undefined;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
      && declaration.parent.flags & ts.NodeFlags.Const && !written(declaration)) {
      node = declaration.initializer; continue;
    }
    return remember(node);
  }
  return undefined;
}
interface CollectionSourceFacts { unsafe: Set<ts.Expression>; initial: WeakMap<ts.Expression, ts.Expression | undefined>; callableReceivers: boolean }
const collectionSources = new WeakMap<ts.SourceFile, CollectionSourceFacts>();
const callableReceiverSources = new WeakMap<ts.SourceFile, CollectionSourceFacts>();
const collectionProperties = new WeakMap<ts.ObjectLiteralExpression, Map<string, ts.Expression | undefined>>();
function collectionProperty(object: ts.ObjectLiteralExpression, key: string, budget?: AnalysisBudget): ts.Expression | undefined {
  budget?.take();
  let properties = collectionProperties.get(object);
  if (!properties) {
    properties = new Map();
    for (const property of object.properties) {
      budget?.take();
      if (ts.isSpreadAssignment(property) || !property.name || ts.isComputedPropertyName(property.name)) {
        budget?.take(properties.size); properties.clear(); continue;
      }
      const name = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name) ? property.name.text : undefined;
      if (name !== undefined) properties.set(name, ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : undefined);
    }
    collectionProperties.set(object, properties);
  }
  return properties.get(key);
}
function collectionKey(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  return ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
}
/** The prototype and constructor share the declaring class's method identity
 * for callable mutation evidence. Ordinary collection allocation resolution
 * deliberately does not use this class-only fallback. */
function callableClassReceiver(node: ts.Expression | undefined): ts.Expression | undefined {
  if (!node) return undefined;
  if (ts.isClassExpression(node)) return node;
  const declaration = ts.isIdentifier(node) ? symbolOf(node)?.valueDeclaration : undefined;
  return declaration && ts.isClassDeclaration(declaration) ? declaration.name : undefined;
}
/** Resolve initial allocations solely to index aliases and escapes. They are
 * not trusted as immutable receiver evidence until the mutation scan finishes. */
function initialCollectionValue(node: ts.Expression | undefined, facts: CollectionSourceFacts, budget?: AnalysisBudget,
  seen = new Set<ts.Node>()): ts.Expression | undefined {
  if (!node || seen.has(node)) return undefined;
  budget?.take();
  if (seen.size > 64) throw new AnalysisLimitError("Startup argument depth limit exceeded");
  if (facts.initial.has(node)) return facts.initial.get(node);
  const next = new Set(seen).add(node);
  let value: ts.Expression | undefined = node;
  const unfolded = protectionArgument(node, budget);
  if (unfolded !== node) value = initialCollectionValue(unfolded, facts, budget, next);
  else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const object = initialCollectionValue(node.expression, facts, budget, next);
    const key = collectionKey(node);
    const classReceiver = facts.callableReceivers
      ? key === "constructor" && object && ts.isNewExpression(object)
        ? callableClassReceiver(initialCollectionValue(object.expression, facts, budget, next))
        : key === "prototype" || key === undefined ? callableClassReceiver(object) : undefined
      : undefined;
    value = classReceiver ?? (object && ts.isObjectLiteralExpression(object) && key !== undefined
      ? initialCollectionValue(collectionProperty(object, key, budget), facts, budget, next) : undefined);
  }
  facts.initial.set(node, value);
  return value;
}
function closedCollectionUse(expression: ts.Expression, constructorCallee = false): boolean {
  let node: ts.Node = expression;
  while (node.parent && (ts.isParenthesizedExpression(node.parent) || ts.isAsExpression(node.parent)
    || ts.isTypeAssertionExpression(node.parent) || ts.isNonNullExpression(node.parent) || ts.isSatisfiesExpression(node.parent))) node = node.parent;
  const parent = node.parent;
  if (!parent) return false;
  if (constructorCallee && ts.isNewExpression(parent) && parent.expression === node) return true;
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node) return true;
  if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)
    && parent.parent.flags & ts.NodeFlags.Const) return true;
  if (ts.isPropertyAssignment(parent) && parent.initializer === node || ts.isShorthandPropertyAssignment(parent) && parent.name === node) return true;
  return false;
}
function collectionFacts(source: ts.SourceFile, budget?: AnalysisBudget, callableReceivers = false): CollectionSourceFacts {
  const cache = callableReceivers ? callableReceiverSources : collectionSources;
  const cached = cache.get(source);
  if (cached) return cached;
  const facts: CollectionSourceFacts = { unsafe: new Set(), initial: new WeakMap(), callableReceivers };
  const mark = (expression: ts.Expression | undefined, seen = new Set<ts.Node>()): void => {
    if (!expression || seen.has(expression)) return;
    budget?.take();
    if (seen.size > 64) throw new AnalysisLimitError("Startup argument depth limit exceeded");
    const next = new Set(seen).add(expression);
    const value = initialCollectionValue(expression, facts, budget);
    if (!value || seen.has(value)) return;
    if (callableReceivers && ts.isIdentifier(value)) {
      const declaration = symbolOf(value)?.valueDeclaration;
      if (declaration && ts.isClassDeclaration(declaration) && declaration.name) facts.unsafe.add(declaration.name);
    }
    if (callableReceivers && ts.isClassExpression(value)) facts.unsafe.add(value);
    if (callableReceivers && ts.isNewExpression(value)) {
      // An instance and its constructor/prototype must invalidate the same
      // class identity, even when the constructor is held in an own property.
      const constructor = callableClassReceiver(initialCollectionValue(value.expression, facts, budget));
      if (constructor) facts.unsafe.add(constructor);
    }
    if (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value) || ts.isNewExpression(value)) {
      if (facts.unsafe.has(value)) return;
      facts.unsafe.add(value);
    }
    // An escaped wrapper exposes its contained allocations too.
    if (ts.isObjectLiteralExpression(value)) for (const property of value.properties) {
      budget?.take();
      if (ts.isPropertyAssignment(property)) mark(property.initializer, next);
      else if (ts.isShorthandPropertyAssignment(property)) mark(property.name, next);
      else if (ts.isSpreadAssignment(property)) mark(property.expression, next);
    }
    else if (ts.isArrayLiteralExpression(value)) for (const element of value.elements) { budget?.take(); mark(ts.isSpreadElement(element) ? element.expression : element, next); }
    else if (ts.isNewExpression(value)) for (const argument of value.arguments ?? []) { budget?.take(); mark(ts.isSpreadElement(argument) ? argument.expression : argument, next); }
  };
  const pending: ts.Node[] = [source];
  while (pending.length) {
    budget?.take();
    const node = pending.pop()!;
    // Unknown use sites (throws, yields, awaits, tagged substitutions, enums,
    // alias containers, coercions, etc.) can expose or mutate an allocation.
    // Only closed data captures and receiver chains are trusted by this filter.
    if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
      || ts.isObjectLiteralExpression(node) || ts.isNewExpression(node))
      && !(ts.isIdentifier(node) && ts.isVariableDeclaration(node.parent) && node.parent.name === node)
      && !(callableReceivers && ts.isIdentifier(node) && ts.isClassDeclaration(node.parent) && node.parent.name === node)
      && !closedCollectionUse(node, callableReceivers)) mark(node);
    const assignment = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
    const target = assignment ? node.left : ts.isDeleteExpression(node) ? node.expression
      : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) ? node.operand : undefined;
    if (target && (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))) mark(target.expression);
    if (assignment) mark(node.right);
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) for (const argument of node.arguments ?? []) mark(ts.isSpreadElement(argument) ? argument.expression : argument);
    // Invoking an own object method can mutate through `this`, whose receiver
    // cannot be recovered by merely indexing the method body's assignments.
    if (!callableReceivers && ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
      const receiver = initialCollectionValue(node.expression.expression, facts, budget);
      if (receiver && ts.isObjectLiteralExpression(receiver)) mark(node.expression.expression);
    }
    if (ts.isObjectLiteralExpression(node) && node.properties.some(property => { budget?.take(); return ts.isGetAccessor(property) || ts.isSetAccessor(property) || ts.isSpreadAssignment(property); })) mark(node);
    // An own method is safe to inspect only while its receiver stays closed.
    // `this` may expose or replace any member, including through nested code.
    if (callableReceivers && node.kind === ts.SyntaxKind.ThisKeyword) {
      for (let owner = node.parent; owner; owner = owner.parent) {
        budget?.take();
        if (ts.isObjectLiteralExpression(owner) || ts.isClassExpression(owner)) { mark(owner); break; }
        if (ts.isClassDeclaration(owner)) { mark(owner.name); break; }
      }
    }
    if (callableReceivers && ts.isClassDeclaration(node) && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) mark(node.name);
    // Arrays, class fields and default parameters are alias carriers outside
    // this deliberately small own-property resolver. Treat their allocations
    // as escaped rather than trusting a mutation through such an alias.
    if (ts.isArrayLiteralExpression(node)) mark(node);
    if ((ts.isPropertyDeclaration(node) || ts.isParameter(node)) && node.initializer) mark(node.initializer);
    if (ts.isReturnStatement(node)) mark(node.expression);
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) mark(node.body);
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const statement = node.parent.parent;
      if (!(node.parent.flags & ts.NodeFlags.Const) || !ts.isIdentifier(node.name)
        || ts.isVariableStatement(statement) && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) mark(node.initializer);
    }
    if (ts.isExportAssignment(node)) mark(node.expression);
    if (ts.isExportSpecifier(node) && !node.isTypeOnly
      && !(ts.isExportDeclaration(node.parent.parent) && node.parent.parent.isTypeOnly)) {
      const symbol = checkerFor(source).getExportSpecifierLocalTargetSymbol(node);
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (declaration && ts.isVariableDeclaration(declaration)) mark(declaration.initializer);
      else if (callableReceivers && declaration && ts.isClassDeclaration(declaration)) mark(declaration.name);
    }
    ts.forEachChild(node, child => { pending.push(child); });
  }
  // A failed scan must not expose partial mutation/escape evidence to another
  // context using this Workspace. Only a completed scan is immutable evidence.
  cache.set(source, facts);
  return facts;
}
function immutableCollectionReceiver(node: ts.Expression | undefined, budget?: AnalysisBudget,
  seen = new Set<ts.Node>()): ts.Expression | undefined {
  if (!node || seen.has(node)) return undefined;
  budget?.take();
  if (seen.size > 64) throw new AnalysisLimitError("Startup argument depth limit exceeded");
  const next = new Set(seen).add(node);
  const value = protectionArgument(node, budget);
  if (!value) return undefined;
  if (value !== node) return immutableCollectionReceiver(value, budget, next);
  const facts = collectionFacts(node.getSourceFile(), budget);
  if (facts.unsafe.has(node)) return undefined;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const object = immutableCollectionReceiver(node.expression, budget, next);
    const key = collectionKey(node);
    return object && ts.isObjectLiteralExpression(object) && key !== undefined
      ? immutableCollectionReceiver(collectionProperty(object, key, budget), budget, next) : undefined;
  }
  return node;
}
function isProtectionCandidate(call: ts.CallExpression, budget?: AnalysisBudget): boolean {
  const cached = protectionCandidates.get(call);
  if (cached !== undefined) return cached;
  let candidate = false;
  if (ts.isPropertyAccessExpression(call.expression) && PROTECTIVE_METHODS.has(call.expression.name.text)) {
    const method = call.expression.name.text;
    const argument = protectionArgument(call.arguments[0], budget);
    const directReceiver = protectionArgument(call.expression.expression, budget);
    const receiver = directReceiver && (ts.isPropertyAccessExpression(directReceiver) || ts.isElementAccessExpression(directReceiver))
      ? immutableCollectionReceiver(directReceiver, budget) : directReceiver;
    const collection = receiver && ts.isNewExpression(receiver) && ts.isIdentifier(receiver.expression)
      && /^(Map|Set|WeakMap|WeakSet)$/.test(receiver.expression.text)
      && !symbolOf(receiver.expression)?.declarations?.length;
    if (collection) candidate = false;
    else if (method === "enableShutdownHooks") candidate = true;
    else if (argument && ts.isStringLiteralLike(argument)) {
      candidate = ["on", "once", "addListener"].includes(method) ? PROTECTION_EVENTS.has(argument.text)
        : PROTECTION_PATH.test(argument.text) || method === "use" && argument.text === "/";
    } else if (argument) {
      // These values cannot be an HTTP path, process event, or mounted router.
      // Unknown names, calls, properties, and helper parameters remain eligible.
      candidate = !(ts.isNumericLiteral(argument) || ts.isBigIntLiteral(argument) || ts.isVoidExpression(argument)
        || argument.kind === ts.SyntaxKind.TrueKeyword || argument.kind === ts.SyntaxKind.FalseKeyword
        || argument.kind === ts.SyntaxKind.NullKeyword);
    }
  }
  protectionCandidates.set(call, candidate);
  return candidate;
}
const emptySummary = (): Summary => ({ mayAbort: false, mayStall: false, calls: new Set(), possibleCalls: new Set(), imports: new Map(), bindings: new Map(), bindingIndex: new Map() });

/** Local execution summaries are scanned once, then composed for each entry.
 * Discovery follows possible execution; protective evidence requires a definite
 * path. Neither unknown branches nor deferred callbacks can establish protection.
 */
export class ServiceContexts {
  private budget: AnalysisBudget;
  // Every derived index shares this context's work budget. If construction
  // fails, none of its partially populated caches may be consumed on retry.
  private failure?: { error: unknown };
  private contexts = new Map<ts.SourceFile, StartupContext>();
  private summaries = new Map<ts.SourceFile, Summary>();
  // Published only after a source scan finishes. A synchronously required
  // module's abrupt completion must stop the requiring execution path too.
  private sourceFlows = new Map<ts.SourceFile, Flow>();
  private preparingRequires = false;
  private activeRequiredSources?: ReadonlySet<ts.SourceFile>;
  private functionSummaries = new Map<ts.FunctionLikeDeclaration, Map<string, Summary>>();
  private callCandidates = new WeakMap<Summary, { listeners: ReadonlySet<ts.CallExpression>; protective: ReadonlySet<ts.CallExpression> }>();
  private awaitedImports = new Map<ts.CallExpression, ts.SourceFile>();
  private completedModules = new Map<ts.SourceFile, Summary>();
  private completedImportGraphs = new Map<ts.SourceFile, readonly Summary[]>();
  private completedSummaryGraphs = new WeakMap<Summary, readonly Summary[]>();
  private contextualCompletionProofs = new WeakMap<Summary, Map<ts.SourceFile, Map<ts.CallExpression, Invocation[]>>>();
  private caughtCompletions = new WeakMap<Summary, Set<Summary>>();
  // A false edge catches import rejection at its consumption site. Repeated
  // imports retain a propagating edge if any consumption leaves it uncaught.
  private completedImportRoots = new WeakMap<Summary, Map<ts.SourceFile, boolean>>();
  // Static dependencies evaluate before a module body. Dynamic import waits
  // retain a separate edge even when the same target is also imported statically.
  private completedImportKinds = new WeakMap<Summary, Map<ts.SourceFile, number>>();
  private promiseCompletions = new Map<ts.CallExpression, Map<string, Map<string, { env: Environment; complete: () => Summary }>>>();
  private awaitedValues = new Map<ts.AwaitExpression, Map<Summary, Environment>>();
  private completedHelpers = new Map<ts.CallExpression, Map<Summary, Environment>>();
  private synchronousHelpers = new Map<ts.CallExpression, Map<Summary, Environment>>();
  private stallingHelpers = new Map<ts.CallExpression, Map<Summary, Environment>>();
  private invocationSites = new Map<string, { call: ts.CallExpression; env: Environment }>();
  private awaitPolicies: boolean[] = [];
  private returnPolicies: boolean[] = [];
  private overridingFinally = new WeakMap<ts.Block, boolean>();
  private returnAdoptions = new WeakMap<Summary, ReturnAdoption[]>();
  private abortingCalls = new Set<ts.CallExpression>();
  private activeFunctions = new Set<ts.FunctionLikeDeclaration>();
  private nodeIds = new WeakMap<ts.Node, number>();
  private nextId = 1;
  private manifestBudget = new RepoInputBudget("service manifest", MAX_MANIFEST_BYTES);
  private packages = new Map<string, Promise<Record<string, unknown> | null>>();
  private entries?: StartupContext[];
  private byOwner = new Map<ts.SourceFile, StartupContext[]>();
  constructor(private root: string, private ws: Workspace) {
    this.budget = new AnalysisBudget("Service startup", projectWorkLimit(ws.units.map(u => u.sf)));
  }
  private analyze<T>(operation: () => T): T {
    if (this.failure) throw this.failure.error;
    try {
      // Lazy union/proof iteration also consumes this budget after a context
      // has been returned. Cached entry points must still reject exhaustion.
      this.budget.take(0);
      return operation();
    }
    catch (error) { this.failure ??= { error }; throw this.failure.error; }
  }
  async manifest(unit: SourceUnit): Promise<Record<string, unknown>> {
    let directory = path.posix.dirname(unit.rel);
    while (true) {
      const rel = path.posix.join(directory, "package.json");
      let pending = this.packages.get(rel);
      if (!pending) {
        pending = readRepoFile(this.root, rel).then(text => {
          if (text === null) return null;
          this.manifestBudget.add(text);
          return parseRepoManifest(text);
        });
        this.packages.set(rel, pending);
      }
      const pkg = await pending;
      if (pkg !== null || directory === ".") return pkg ?? {};
      directory = path.posix.dirname(directory);
    }
  }
  entryContexts(): StartupContext[] {
    return this.analyze(() => this.buildEntries());
  }
  private buildEntries(): StartupContext[] {
    if (!this.entries) {
      const imported = new Set<ts.SourceFile>();
      // Use the same executed-import graph for entry discovery and ownership.
      // A require inside a directly called helper is not an independent entry.
      for (const unit of this.ws.units) {
        for (const target of this.summary(unit.sf).imports.keys()) { this.budget.take(); imported.add(target); }
      }
      this.entries = this.ws.units.filter(unit => !imported.has(unit.sf)).map(unit => this.startup(unit.sf));
      const covered = new Set<ts.SourceFile>();
      const index = (entry: StartupContext) => {
        for (const source of entry.sources) {
          this.budget.take();
          covered.add(source);
          const owners = this.byOwner.get(source) ?? [];
          owners.push(entry);
          this.byOwner.set(source, owners);
        }
      };
      for (const entry of this.entries) index(entry);
      // Closed runtime-import cycles have no indegree-zero entry.
      for (const unit of this.ws.units) if (!covered.has(unit.sf)) {
        const entry = this.startup(unit.sf);
        this.entries.push(entry);
        index(entry);
      }
    }
    return this.entries;
  }
  owners(sf: ts.SourceFile): StartupContext[] {
    this.entryContexts();
    return this.byOwner.get(sf) ?? [this.startup(sf)];
  }
  startup(sf: ts.SourceFile): StartupContext {
    return this.analyze(() => this.buildStartup(sf));
  }
  private buildStartup(sf: ts.SourceFile): StartupContext {
    const cached = this.contexts.get(sf);
    if (cached) return cached;
    const chunks = new Map<Summary, boolean>();
    const sources = new Set<ts.SourceFile>();
    const visited = new Map<ts.SourceFile, boolean>();
    const pending: [ts.SourceFile, boolean][] = [[sf, true]];
    while (pending.length) {
      this.budget.take();
      const [source, definite] = pending.pop()!;
      if (visited.has(source) && (visited.get(source) || !definite)) continue;
      visited.set(source, definite);
      sources.add(source);
      const summary = this.summary(source);
      chunks.set(summary, !!chunks.get(summary) || definite);
      for (const [target, certain] of summary.imports) pending.push([target, definite && certain]);
    }
    // Structural sharing: composing another entry never copies shared call sets.
    const combined = {
      calls: new UnionSet([...chunks].filter(([, certain]) => certain).map(([chunk]) => chunk.calls), this.budget),
      protectiveCalls: new UnionSet([...chunks].filter(([, certain]) => certain).map(([chunk]) => this.candidatesFor(chunk).protective), this.budget),
      possibleCalls: new UnionSet([...chunks.keys()].map(chunk => chunk.possibleCalls), this.budget),
      possibleListeners: new UnionSet([...chunks.keys()].map(chunk => this.candidatesFor(chunk).listeners), this.budget),
    };
    const variants = (call: ts.Node, protective = false): Invocation[] => {
      const result: Invocation[] = [];
      for (const [chunk, certain] of chunks) {
        this.budget.take();
        for (const invocation of chunk.bindings.get(call) ?? []) {
          this.budget.take();
          result.push({ env: invocation.env, definite: certain && invocation.definite });
        }
      }
      return protective && result.some(invocation => invocation.definite) ? result.filter(invocation => invocation.definite) : result;
    };
    const protectionCache = new Map<ts.CallExpression, ReadonlySet<ts.CallExpression>>();
    const views = new Map<ts.Node, readonly StartupContext[]>();
    const protectiveViews = new Map<ts.Node, readonly StartupContext[]>();
    const makeView = (call: ts.Node, invocation: Invocation, inherited?: ProofBindings): StartupContext => {
      const bindings = inherited ?? new Map<ts.Node, Map<Environment, Invocation>>();
      let hasProof = !!inherited;
      const localProofs = new Map<ts.CallExpression, ReadonlySet<ts.CallExpression>>();
      const selected = (site: ts.Node, certain = false): Invocation[] => {
        const all = variants(site);
        if (certain && hasProof) {
          const allowed = new Map<Environment, Invocation>(bindings.get(site));
          if (ts.isCallExpression(site) && combined.protectiveCalls.has(site)) {
            for (const variant of all) if (variant.definite) allowed.set(variant.env, variant);
          }
          return [...allowed.values()];
        }
        return all.filter(variant => this.compatible(variant.env, invocation.env));
      };
      const view: StartupContext = {
        ...result,
        allocationScope: (node, site) => {
          if (!site || site === call) return allocationScope(node, invocation.env);
          const scopes = selected(site).map(variant => allocationScope(node, variant.env));
          return scopes.length && scopes.every(scope => scope === scopes[0]) ? scopes[0] : undefined;
        },
        resolveExpression: (node, site) => {
          if (!site || site === call) return resolveArgument(node, invocation.env);
          const resolved = selected(site).map(variant => resolveArgument(node, variant.env));
          return !resolved.length ? resolveArgument(node, invocation.env)
            : resolved.every(value => this.argumentKey(value) === this.argumentKey(resolved[0])) ? resolved[0] : undefined;
        },
        protectionCallsFor: listener => {
          let proof = localProofs.get(listener);
          if (!proof) {
            const record = (site: ts.CallExpression, alternatives: readonly Invocation[]) => {
              const allowed = bindings.get(site) ?? new Map<Environment, Invocation>();
              for (const alternative of alternatives) { this.budget.take(); allowed.set(alternative.env, alternative); }
              bindings.set(site, allowed);
            };
            proof = this.relativeProtection(listener, combined, invocation.env, variants, record, false, new Set(), sf);
            hasProof = true;
            localProofs.set(listener, proof);
          }
          return proof;
        },
        invocationsFor: (site, certain = false) => site === call ? [view]
          : selected(site, certain).map(variant => makeView(site, variant, hasProof ? bindings : undefined)),
      };
      return view;
    };
    const result: StartupContext = {
      calls: combined.calls,
      protectiveCalls: combined.protectiveCalls,
      possibleCalls: combined.possibleCalls,
      possibleListeners: combined.possibleListeners,
      sources,
      allocationScope: (node, site) => {
        if (!containingFunction(node)) return "module";
        const scopes = site ? variants(site).map(invocation => allocationScope(node, invocation.env)) : [];
        return scopes.length && scopes.every(scope => scope === scopes[0]) ? scopes[0] : undefined;
      },
      protectionCallsFor: listener => {
        let proof = protectionCache.get(listener);
        if (!proof) {
          const contexts = result.invocationsFor(listener);
          if (!contexts.length) proof = combined.protectiveCalls;
          else {
            const alternatives = contexts.map(context => context.protectionCallsFor(listener));
            const intersection = new Set<ts.CallExpression>();
            for (const candidate of alternatives[0]) if (alternatives.every(calls => calls.has(candidate))) intersection.add(candidate);
            proof = intersection;
          }
          protectionCache.set(listener, proof);
        }
        return proof;
      },
      invocationsFor: (call, protective = false) => {
        const cache = protective ? protectiveViews : views;
        let found = cache.get(call);
        if (!found) { found = variants(call, protective).map(invocation => makeView(call, invocation)); cache.set(call, found); }
        return found;
      },
      resolveExpression: (node, call) => {
        if (!call) return resolveArgument(node);
        const resolved = variants(call).map(invocation => resolveArgument(node, invocation.env));
        return !resolved.length ? resolveArgument(node) : resolved.every(value => this.argumentKey(value) === this.argumentKey(resolved[0])) ? resolved[0] : undefined;
      },
    };
    this.contexts.set(sf, result);
    return result;
  }
  /** A listener establishes that its own branch/prefix was reached. Accept
   * direct straight-line registrations in that same branch, without promoting
   * nested conditions, callbacks, catch-only handlers, or aborting prefixes.
   * General conditional helper implication is intentionally not inferred.
   */
  private compatible(a: Environment, b: Environment): boolean {
    this.budget.take(a.size + (a.scopes?.size ?? 0) + 1);
    for (const [fn, scope] of a.scopes ?? []) if (b.scopes?.has(fn) && b.scopes.get(fn) !== scope) return false;
    for (const [declaration, value] of a) if (b.has(declaration) && this.argumentKey(value) !== this.argumentKey(b.get(declaration))) return false;
    return true;
  }
  private relativeProtection(listener: ts.CallExpression,
    summary: { calls: ReadonlySet<ts.CallExpression>; protectiveCalls?: ReadonlySet<ts.CallExpression>; possibleCalls: ReadonlySet<ts.CallExpression> },
    env: Environment, variants: (site: ts.Node) => Invocation[],
    record: (site: ts.CallExpression, alternatives: readonly Invocation[]) => void,
    beforeOnly = false, active = new Set<string>(), entry?: ts.SourceFile): ReadonlySet<ts.CallExpression> {
    const base = summary.protectiveCalls ?? summary.calls;
    if (!summary.possibleCalls.has(listener)) return base;
    const result = new Set<ts.CallExpression>();
    const inherited: ReadonlySet<ts.CallExpression>[] = [base, result];
    // A helper's current invocation also inherits setup completed before its
    // caller invoked it. Its own completion is excluded from that prefix.
    const fn = containingFunction(listener);
    const scope = fn && env.scopes?.get(fn);
    const caller = scope && this.invocationSites.get(scope);
    if (scope && caller && !active.has(scope)) {
      const next = new Set(active).add(scope);
      inherited.push(this.relativeProtection(caller.call, summary, caller.env, variants, record, true, next, entry));
    }
    const finish = () => new UnionSet(inherited, this.budget);
    let statement: ts.Node = listener;
    while (statement.parent && !ts.isBlock(statement.parent) && !ts.isSourceFile(statement.parent)) statement = statement.parent;
    const block = statement.parent;
    if (!block || !ts.isBlock(block) && !ts.isSourceFile(block) || !ts.isStatement(statement)) return finish();
    let parent: ts.Node | undefined = block;
    let conditional = false;
    while (parent && !ts.isFunctionLike(parent) && !ts.isSourceFile(parent)) {
      if (ts.isIfStatement(parent) || ts.isCatchClause(parent)) conditional = true;
      parent = parent.parent;
    }
    if (!ts.isSourceFile(block) && !conditional && (!parent || !ts.isFunctionLike(parent))) return finish();
    const straight = (node: ts.Statement): boolean => ts.isExpressionStatement(node) || ts.isVariableStatement(node)
      || ts.isFunctionDeclaration(node) || ts.isEmptyStatement(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)
      || ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isExportAssignment(node) || ts.isClassDeclaration(node)
      || ts.isIfStatement(node) && literalTruth(staticArgument(node.expression, env), env) !== undefined;
    type Event = { kind: "call"; call: ts.CallExpression } | { kind: "await"; node: ts.AwaitExpression } | { kind: "uncertain" };
    const events = (node: ts.Node): Event[] => {
      const found: Event[] = [];
      const visit = (item: ts.Node): void => {
        this.budget.take();
        if (ts.isFunctionLike(item)) return;
        // Imports are evaluated before the body (or erased), while class
        // declarations evaluate only their heritage, keys and static members.
        if (ts.isImportDeclaration(item) || ts.isExportDeclaration(item)) return;
        if (ts.isClassDeclaration(item) || ts.isClassExpression(item)) {
          for (const evaluated of this.classEvaluation(item)) visit(evaluated);
          return;
        }
        if (ts.isIfStatement(item) || ts.isConditionalExpression(item)) {
          const condition = ts.isIfStatement(item) ? item.expression : item.condition;
          visit(condition);
          const value = literalTruth(staticArgument(condition, env), env);
          if (value === undefined) { found.push({ kind: "uncertain" }); return; }
          const selected = ts.isIfStatement(item) ? value ? item.thenStatement : item.elseStatement : value ? item.whenTrue : item.whenFalse;
          if (selected) visit(selected);
          return;
        }
        if (ts.isBinaryExpression(item) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(item.operatorToken.kind)) {
          visit(item.left);
          const left = staticArgument(item.left, env), truth = literalTruth(left, env);
          const execute = item.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? truth
            : item.operatorToken.kind === ts.SyntaxKind.BarBarToken ? truth === undefined ? undefined : !truth : literalNullish(left, env);
          if (execute === undefined) found.push({ kind: "uncertain" }); else if (execute) visit(item.right);
          return;
        }
        if (ts.isCallExpression(item) || ts.isPropertyAccessExpression(item) || ts.isElementAccessExpression(item)) {
          const receivers = optionalReceivers(item);
          // An optional tail may be skipped, but the receiver of the first
          // unresolved guard is always evaluated. Earlier guards precede later
          // ones even though optionalReceivers collects from outside inward.
          for (let index = receivers.length - 1; index >= 0; index--) {
            const receiver = receivers[index], value = staticArgument(receiver, env);
            if (isNullish(value) || !definitelyPresent(value)) {
              visit(receiver);
              if (!isNullish(value)) found.push({ kind: "uncertain" });
              return;
            }
          }
        }
        // Natural child order evaluates a callee and its arguments before the
        // call itself. An awaited argument therefore precedes listener startup.
        ts.forEachChild(item, child => { visit(child); });
        if (ts.isCallExpression(item)) found.push({ kind: "call", call: item });
        if (ts.isAwaitExpression(item)) found.push({ kind: "await", node: item });
      };
      visit(node);
      return found;
    };
    const index = block.statements.indexOf(statement);
    if (index < 0 || !straight(statement)) return finish();
    let start = index, end = index;
    while (start > 0 && straight(block.statements[start - 1])) start--;
    while (end + 1 < block.statements.length && straight(block.statements[end + 1])) end++;
    let reached = false;
    for (let i = start; i <= end; i++) for (const event of events(block.statements[i])) {
      if (event.kind === "await") {
        if (reached) return finish();
        for (const [completion, callerEnv] of this.awaitedValues.get(event.node) ?? []) {
          this.budget.take();
          if (!this.compatible(callerEnv, env)) continue;
          this.recordCompletedSummary(completion, result, record, entry);
        }
        continue;
      }
      if (event.kind === "uncertain") { if (reached) return finish(); continue; }
      const call = event.call;
      if (call === listener) { if (beforeOnly) return finish(); reached = true; }
      const alternatives = variants(call).filter(invocation => this.compatible(invocation.env, env));
      if (!alternatives.length) continue;
      const stalls = [...(this.stallingHelpers.get(call)?.values() ?? [])].some(callerEnv => this.compatible(callerEnv, env));
      if (this.abortingCalls.has(call) || stalls) {
        if (ts.isSourceFile(block) || reached) return finish();
        continue;
      }
      if (isProtectionCandidate(call, this.budget)) { result.add(call); record(call, alternatives); }
      // A reached synchronous helper finishes in the same turn, including
      // when it follows the listener. Its own guaranteed calls are evidence
      // even if an earlier await made the enclosing source summary uncertain.
      for (const [completion, callerEnv] of this.synchronousHelpers.get(call) ?? []) {
        this.budget.take();
        if (!this.compatible(callerEnv, env)) continue;
        this.recordCompletedSummary(completion, result, record, entry);
      }
      if (!reached) for (const [completion, callerEnv] of this.completedHelpers.get(call) ?? []) {
        this.budget.take();
        if (!this.compatible(callerEnv, env)) continue;
        this.recordCompletedSummary(completion, result, record, entry);
      }
      const dependency = !reached && this.awaitedImports.get(call);
      if (dependency) this.recordCompletedImport(dependency, result, record);
    }
    return finish();
  }
  /** Imported-module completion is separate from its ordinary startup prefix:
   * an importer reaching a later listener proves its awaited module completed,
   * but that proof cannot protect an earlier listener inside the dependency. */
  private completedModule(sf: ts.SourceFile): Summary {
    return this.analyze(() => {
      const cached = this.completedModules.get(sf);
      if (cached) return cached;
      const summary = emptySummary();
      this.awaitPolicies.push(true);
      this.returnPolicies.push(false);
      try {
        const flow = this.scan(sf, true, new Map(), summary, 0);
        summary.mayStall ||= !flow.normal && !!flow.suspended && !flow.thrown && !flow.returned;
        this.completedModules.set(sf, summary);
        return summary;
      } finally { this.returnPolicies.pop(); this.awaitPolicies.pop(); }
    });
  }
  private completedImportGraph(sf: ts.SourceFile): readonly Summary[] {
    return this.analyze(() => {
      const cached = this.completedImportGraphs.get(sf);
      if (cached) return cached;
      const graph = this.completedSummaryGraph(this.completedModule(sf));
      this.completedImportGraphs.set(sf, graph);
      return graph;
    });
  }
  private completedSummaryGraph(rootSummary: Summary): readonly Summary[] {
    return this.analyze(() => {
      const cached = this.completedSummaryGraphs.get(rootSummary);
      if (cached) return cached;
      interface Graph { summary: Summary; children: Graph[] }
      interface Result { graph?: Graph; stalled: boolean }
      interface Frame {
        required: boolean; graph: Graph; edges: [Summary, boolean, boolean][];
        next: number; failed: boolean; stalled: boolean; dynamicDepth: number;
      }
      // Caught helper completions retain their own import prerequisites. A
      // failed helper cannot donate post-import calls to its catching caller,
      // while the caller's independently reached setup remains available.
      const active = new Map<Summary, Frame>();
      const results = new Map<Summary, Result>();
      const frame = (summary: Summary, required: boolean, dynamicDepth: number): Frame => {
        this.budget.take();
        const roots = this.completedImportRoots.get(summary);
        const kinds = this.completedImportKinds.get(summary);
        const staticEdges: [Summary, boolean, boolean][] = [];
        const bodyEdges: [Summary, boolean, boolean][] = [];
        for (const [target, certain] of summary.imports) {
          this.budget.take();
          if (!certain) continue;
          if (roots?.has(target)) {
            const targetSummary = this.completedModule(target);
            const kind = kinds?.get(target) ?? 2;
            if (kind & 1) staticEdges.push([targetSummary, true, false]);
            if (kind & 2) bodyEdges.push([targetSummary, !!roots.get(target), true]);
          } else bodyEdges.push([this.summary(target), false, false]);
        }
        for (const child of this.caughtCompletions.get(summary) ?? []) { this.budget.take(); bodyEdges.push([child, false, false]); }
        this.budget.take(staticEdges.length + bodyEdges.length);
        const current: Frame = { required, graph: { summary, children: [] }, edges: [...staticEdges, ...bodyEdges], next: 0,
          failed: summary.mayAbort || summary.mayStall, stalled: summary.mayStall, dynamicDepth };
        active.set(summary, current);
        return current;
      };
      const stack = [frame(rootSummary, true, 0)];
      let root: Graph | undefined;
      while (stack.length) {
        this.budget.take();
        const current = stack[stack.length - 1];
        // Rejected modules can depend on earlier pending static imports;
        // noncompletion cannot be swallowed by a rejection catch.
        if (current.next < current.edges.length) {
          const [target, required, dynamic] = current.edges[current.next++];
          const ancestor = active.get(target);
          if (ancestor) {
            // Static linking cycles expose live bindings and can finish. An
            // awaited dynamic edge on the active cycle instead waits for a
            // still-evaluating module; catching rejection cannot resume it.
            if (dynamic || current.dynamicDepth > ancestor.dynamicDepth) {
              current.failed = true; current.stalled = true;
            }
            continue;
          }
          const child = results.get(target);
          if (child) {
            if (child.graph) current.graph.children.push(child.graph);
            else if (required || child.stalled) { current.failed = true; current.stalled ||= child.stalled; }
          } else stack.push(frame(target, required, current.dynamicDepth + (dynamic ? 1 : 0)));
          continue;
        }
        stack.pop(); active.delete(current.graph.summary);
        const result: Result = { graph: current.failed ? undefined : current.graph, stalled: current.stalled };
        results.set(current.graph.summary, result);
        const parent = stack[stack.length - 1];
        if (parent) {
          if (result.graph) parent.graph.children.push(result.graph);
          else if (current.required || result.stalled) { parent.failed = true; parent.stalled ||= result.stalled; }
        } else root = result.graph;
      }
      const chunks: Summary[] = [];
      const seen = new Set<Graph>();
      const pending = root ? [root] : [];
      while (pending.length) {
        this.budget.take();
        const graph = pending.pop()!;
        if (seen.has(graph)) continue;
        seen.add(graph); chunks.push(graph.summary);
        for (const child of graph.children) { this.budget.take(); pending.push(child); }
      }
      this.completedSummaryGraphs.set(rootSummary, chunks);
      return chunks;
    });
  }
  private recordCompletedSummary(source: Summary, result: Set<ts.CallExpression>,
    record: (site: ts.CallExpression, alternatives: readonly Invocation[]) => void, entry?: ts.SourceFile): void {
    const graph = this.completedSummaryGraph(source);
    this.recordSummaryGraph(graph, result, record);
    if (graph.length || !entry) return;
    // A helper-only graph can re-enter its caller's static import cycle even
    // though that dependency already completed before the caller body. Accept
    // only exact invocation proof also validated by this entry's full graph;
    // unrelated successful invocations cannot backfill a failed helper.
    const contexts = this.contextualCompletionProofs.get(source) ?? new Map();
    let proof = contexts.get(entry);
    if (!proof) {
      proof = new Map();
      const completed = this.completedImportGraph(entry);
      for (const call of this.candidatesFor(source).protective) {
        this.budget.take();
        const matching: Invocation[] = [];
        for (const [key, invocation] of source.bindingIndex.get(call) ?? []) {
          this.budget.take();
          if (!invocation.definite) continue;
          for (const chunk of completed) {
            this.budget.take();
            if (chunk.calls.has(call) && chunk.bindingIndex.get(call)?.get(key)?.definite) {
              matching.push(invocation); break;
            }
          }
        }
        if (matching.length) proof.set(call, matching);
      }
      contexts.set(entry, proof); this.contextualCompletionProofs.set(source, contexts);
    }
    for (const [call, alternatives] of proof) { this.budget.take(); result.add(call); record(call, alternatives); }
  }
  private recordCompletedImport(source: ts.SourceFile, result: Set<ts.CallExpression>,
    record: (site: ts.CallExpression, alternatives: readonly Invocation[]) => void): void {
    this.recordSummaryGraph(this.completedImportGraph(source), result, record);
  }
  private recordSummaryGraph(graph: readonly Summary[], result: Set<ts.CallExpression>,
    record: (site: ts.CallExpression, alternatives: readonly Invocation[]) => void): void {
    for (const summary of graph) {
      this.budget.take();
      for (const call of this.candidatesFor(summary).protective) {
        this.budget.take(); result.add(call);
        record(call, (summary.bindings.get(call) ?? []).filter(invocation => invocation.definite));
      }
    }
  }
  private awaitFailureCaught(node: ts.Node): boolean {
    let value = node;
    if (!ts.isAwaitExpression(value)) {
      while (value.parent && isTransparentExpression(value.parent) && value.parent.expression === value) {
        this.budget.take(); value = value.parent;
      }
      if (!value.parent || !ts.isAwaitExpression(value.parent)) return false;
      value = value.parent;
    }
    for (let parent = value.parent; parent && !ts.isFunctionLike(parent); value = parent, parent = parent.parent) {
      this.budget.take();
      if (ts.isTryStatement(parent) && parent.tryBlock === value && parent.catchClause) return true;
    }
    return false;
  }
  private markCompletedImport(summary: Summary, source: ts.SourceFile, propagatesFailure = true, kind = 2): void {
    this.budget.take();
    const completed = this.completedImportRoots.get(summary) ?? new Map<ts.SourceFile, boolean>();
    completed.set(source, !!completed.get(source) || propagatesFailure);
    this.completedImportRoots.set(summary, completed);
    const kinds = this.completedImportKinds.get(summary) ?? new Map<ts.SourceFile, number>();
    kinds.set(source, (kinds.get(source) ?? 0) | kind);
    this.completedImportKinds.set(summary, kinds);
  }
  private candidatesFor(summary: Summary): { listeners: ReadonlySet<ts.CallExpression>; protective: ReadonlySet<ts.CallExpression> } {
    let candidates = this.callCandidates.get(summary);
    if (!candidates) {
      const listeners = new Set<ts.CallExpression>();
      const protective = new Set<ts.CallExpression>();
      // Shared summaries are immutable once composed. Index syntax once, so
      // checking another service never revisits unrelated shared startup calls.
      for (const call of summary.possibleCalls) {
        this.budget.take();
        if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "listen") listeners.add(call);
        if (summary.calls.has(call) && isProtectionCandidate(call, this.budget)) protective.add(call);
      }
      candidates = { listeners, protective };
      this.callCandidates.set(summary, candidates);
    }
    return candidates;
  }
  private summary(sf: ts.SourceFile): Summary {
    // Actual CommonJS backedges observe partial exports. Every other missing
    // dependency is suspended into the iterative scheduler, never evaluated
    // through an unbounded native call stack.
    if (this.preparingRequires && !this.sourceFlows.has(sf) && !this.activeRequiredSources?.has(sf)) throw new RequiredSourcePending(sf);
    return this.analyze(() => {
      if (!this.sourceFlows.has(sf) && !this.activeRequiredSources?.has(sf)) this.prepareRequiredSource(sf);
      return this.summaries.get(sf)!;
    });
  }
  /** Execute source scans in require order. A newly reached dependency suspends
   * its caller; only the unfinished statement is retried after that dependency
   * completes. Completed source prefixes retain their cursor and cached flows. */
  private prepareRequiredSource(source: ts.SourceFile): void {
    if (this.sourceFlows.has(source) || this.activeRequiredSources?.has(source)) return;
    if (this.preparingRequires) throw new RequiredSourcePending(source);
    interface SourceScan {
      source: ts.SourceFile; summary: Summary; env: Environment;
      importsDone: boolean; next: number; flow: Flow;
    }
    this.preparingRequires = true;
    const active = new Set<ts.SourceFile>();
    this.activeRequiredSources = active;
    const frame = (sf: ts.SourceFile): SourceScan => {
      this.budget.take();
      const summary = emptySummary();
      this.summaries.set(sf, summary); active.add(sf);
      return { source: sf, summary, env: new Map(), importsDone: false, next: 0, flow: NORMAL };
    };
    const pending = [frame(source)];
    try {
      while (pending.length) {
        this.budget.take();
        const current = pending[pending.length - 1], summary = current.summary;
        let beforeAbort = summary.mayAbort, beforeStall = summary.mayStall;
        const callerAwaits = this.awaitPolicies, callerReturns = this.returnPolicies;
        this.awaitPolicies = []; this.returnPolicies = [];
        try {
          // Static dependencies are evaluated before the module body even
          // when their declarations follow a suspended/abrupt statement.
          if (!current.importsDone) {
            while (current.next < current.source.statements.length) {
              this.budget.take();
              const statement = current.source.statements[current.next];
              beforeAbort = summary.mayAbort; beforeStall = summary.mayStall;
              if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) this.scan(statement, true, current.env, summary, 1);
              current.next++;
            }
            current.importsDone = true; current.next = 0;
          }
          while (current.next < current.source.statements.length && current.flow.normal) {
            this.budget.take();
            const statement = current.source.statements[current.next];
            if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) { current.next++; continue; }
            beforeAbort = summary.mayAbort; beforeStall = summary.mayStall;
            const next = this.scan(statement, !current.flow.mayExit, current.env, summary, 1);
            current.flow = { normal: next.normal, mayExit: current.flow.mayExit || next.mayExit,
              thrown: current.flow.thrown || next.thrown, returned: current.flow.returned || next.returned,
              suspended: current.flow.suspended || next.suspended };
            current.next++;
          }
          this.sourceFlows.set(current.source, current.flow);
          active.delete(current.source); pending.pop();
        } catch (error) {
          if (!(error instanceof RequiredSourcePending)) throw error;
          summary.mayAbort = beforeAbort; summary.mayStall = beforeStall;
          // The unfinished prefix is a partial-export view only for modules
          // actually active on this require stack. It is never a cached flow.
          if (!this.sourceFlows.has(error.source) && !active.has(error.source)) pending.push(frame(error.source));
        } finally { this.awaitPolicies = callerAwaits; this.returnPolicies = callerReturns; }
      }
    } finally { this.activeRequiredSources = undefined; this.preparingRequires = false; }
  }
  private merge(target: Summary, source: Summary, definite: boolean, propagateAbort = true, catchesImports = false): void {
    target.mayAbort ||= propagateAbort && source.mayAbort;
    target.mayStall ||= propagateAbort && source.mayStall;
    const gated = catchesImports && (source.imports.size > 0 || !!this.caughtCompletions.get(source)?.size);
    for (const call of source.possibleCalls) { this.budget.take(); target.possibleCalls.add(call); }
    if (definite && !gated) for (const call of source.calls) { this.budget.take(); target.calls.add(call); }
    for (const [sourceFile, certain] of source.imports) {
      this.budget.take();
      target.imports.set(sourceFile, !!target.imports.get(sourceFile) || definite && !gated && certain);
    }
    if (definite) {
      const children = this.caughtCompletions.get(target) ?? new Set<Summary>();
      if (gated) { this.budget.take(); children.add(source); }
      else {
        for (const [dependency, propagates] of this.completedImportRoots.get(source) ?? []) {
          this.markCompletedImport(target, dependency, propagates, this.completedImportKinds.get(source)?.get(dependency) ?? 2);
        }
        for (const child of this.caughtCompletions.get(source) ?? []) { this.budget.take(); children.add(child); }
      }
      if (children.size) this.caughtCompletions.set(target, children);
    }
    for (const [call, invocations] of source.bindings) for (const invocation of invocations) this.recordBindings(target, call, invocation.env, definite && !gated && invocation.definite);
  }
  private recordBindings(summary: Summary, call: ts.Node, env: Environment, definite: boolean): void {
    const existing = summary.bindings.get(call) ?? [];
    // Canonical keys retain declaration/value and allocating invocation identity
    // without repeatedly comparing every preceding alternative at this node.
    this.budget.take(env.size + (env.scopes?.size ?? 0) + 1);
    const bindings = [...env].map(([parameter, value]) => [this.id(parameter), this.argumentKey(value)])
      .sort((a, b) => { this.budget.take(); return Number(a[0]) - Number(b[0]); });
    const scopes = [...(env.scopes ?? [])].map(([fn, scope]) => [this.id(fn), scope])
      .sort((a, b) => { this.budget.take(); return Number(a[0]) - Number(b[0]); });
    const key = JSON.stringify([bindings, scopes]);
    let index = summary.bindingIndex.get(call);
    if (!index) { index = new Map(); summary.bindingIndex.set(call, index); }
    const same = index.get(key);
    if (same) { same.definite ||= definite; return; }
    this.budget.take(env.size + (env.scopes?.size ?? 0) + 1);
    const invocation = { env: copyEnvironment(env), definite };
    existing.push(invocation);
    index.set(key, invocation);
    summary.bindings.set(call, existing);
  }
  private argumentKey(node: ts.Expression | undefined): string {
    if (!node) return "unknown";
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return `${node.kind}:${node.text}`;
    if (ts.isIdentifier(node)) {
      const symbol = symbolOf(node);
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (!declaration) return `global:${node.text}`;
      if (!written(declaration)) return `binding:${this.id(declaration)}`;
    }
    return `node:${this.id(node)}`;
  }
  private addImport(summary: Summary, from: ts.SourceFile, argument: ts.Expression | undefined, definite: boolean, waitsForModule = false): void {
    if (!argument || !ts.isStringLiteralLike(argument)) return;
    const project = projectFor(from);
    const rel = project?.resolve(from.fileName, argument.text);
    const source = rel && project?.sources.get(rel);
    if (source) {
      summary.imports.set(source, !!summary.imports.get(source) || definite);
      if (definite && waitsForModule) this.markCompletedImport(summary, source, true, 1);
    }
  }
  private id(node: ts.Node | undefined): string {
    if (!node) return "?";
    let id = this.nodeIds.get(node);
    if (!id) { id = this.nextId++; this.nodeIds.set(node, id); }
    return String(id);
  }
  /** Whether a return can be replaced by an abrupt enclosing finally. */
  private returnCanBeOverridden(node: ts.Node, env?: Environment): boolean {
    let child = node;
    for (let parent = node.parent; parent && !ts.isFunctionLike(parent); child = parent, parent = parent.parent) {
      this.budget.take();
      if (!ts.isTryStatement(parent) || !parent.finallyBlock || child === parent.finallyBlock) continue;
      let overrides = this.overridingFinally.get(parent.finallyBlock);
      if (overrides === undefined) {
        overrides = false;
        const pending: ts.Node[] = [parent.finallyBlock];
        while (pending.length) {
          this.budget.take();
          const current = pending.pop()!;
          if (ts.isFunctionLike(current) || ts.isClassDeclaration(current) || ts.isClassExpression(current)) continue;
          if (ts.isReturnStatement(current) || ts.isThrowStatement(current) || ts.isBreakStatement(current) || ts.isContinueStatement(current)) { overrides = true; break; }
          ts.forEachChild(current, next => { pending.push(next); });
        }
        this.overridingFinally.set(parent.finallyBlock, overrides);
      }
      if (overrides) {
        const pending: ts.Node[] = [parent.finallyBlock];
        while (pending.length) {
          this.budget.take();
          const current = pending.pop()!;
          if (ts.isFunctionLike(current) || ts.isClassDeclaration(current) || ts.isClassExpression(current)) continue;
          if (ts.isReturnStatement(current) || ts.isThrowStatement(current) || ts.isBreakStatement(current) || ts.isContinueStatement(current)) return true;
          if (ts.isIfStatement(current) || ts.isConditionalExpression(current)) {
            const value = literalTruth(staticArgument(ts.isIfStatement(current) ? current.expression : current.condition, env), env);
            if (value !== undefined) {
              const selected = ts.isIfStatement(current) ? value ? current.thenStatement : current.elseStatement : value ? current.whenTrue : current.whenFalse;
              if (selected) pending.push(selected);
              continue;
            }
          }
          ts.forEachChild(current, next => { pending.push(next); });
        }
      }
    }
    return false;
  }
  private returnedValue(node: ts.Expression, env?: Environment): boolean {
    let value: ts.Node = node;
    while (value.parent) {
      this.budget.take();
      const parent = value.parent;
      if (isTransparentExpression(parent) && parent.expression === value
        || ts.isConditionalExpression(parent) && (parent.whenTrue === value || parent.whenFalse === value)
        || ts.isBinaryExpression(parent) && parent.right === value
          && [ts.SyntaxKind.CommaToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(parent.operatorToken.kind)) {
        value = parent; continue;
      }
      if (ts.isBinaryExpression(parent) && parent.left === value) {
        const left = this.promiseValue(parent.left, env);
        const truth = literalTruth(left, env), nullish = literalNullish(left, env);
        if (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken && truth === true
          || parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && nullish === false) { value = parent; continue; }
      }
      return (ts.isReturnStatement(parent) && parent.expression === value
        || ts.isArrowFunction(parent) && parent.body === value) && !this.returnCanBeOverridden(value, env);
    }
    return false;
  }
  private invoke(fn: ts.FunctionLikeDeclaration, call: ts.CallExpression, env: Environment, out: Summary, definite: boolean, depth: number): Flow {
    if (!fn.body || fn.asteriskToken) return NORMAL;
    const body = fn.body;
    const asynchronous = !!fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword);
    const explicitAwait = directlyAwaited(call, this.budget);
    const adoptsReturn = !explicitAwait && this.returnPolicies.at(-1) === true && this.returnedValue(call, env);
    const awaited = explicitAwait || adoptsReturn;
    const propagates = !asynchronous || awaited;
    if (this.activeFunctions.has(fn)) {
      out.mayAbort ||= propagates;
      if (propagates) this.abortingCalls.add(call);
      return { normal: true, mayExit: propagates, thrown: propagates };
    }
    if (depth > 64) throw new AnalysisLimitError("Startup callable depth limit exceeded");
    const hasSpread = call.arguments.some(ts.isSpreadElement);
    const argumentsAtCall = call.arguments.map(arg => resolveArgument(arg, env));
    const caller = containingFunction(call);
    const scope = `${caller ? env.scopes?.get(caller) ?? "unknown" : "module"}/${this.id(call)}`;
    this.invocationSites.set(scope, { call, env: copyEnvironment(env) });
    const key = `${scope}:${propagates ? "awaited" : "detached"}:${hasSpread ? "spread" : "fixed"}:${call.arguments.length}:${argumentsAtCall.map(arg => this.id(arg)).join(",")}:${[...env].map(([p, v]) => this.id(p) + "=" + this.id(v)).join(",")}`;
    const callerCompletes = this.awaitPolicies.at(-1) === true;
    const summaryFor = (completes: boolean, adoptsReturn: boolean): Summary => {
      const cacheKey = `${completes ? "complete" : "prefix"}:${adoptsReturn ? "adopt" : "return"}:${key}`;
      let cache = this.functionSummaries.get(fn);
      if (!cache) { cache = new Map(); this.functionSummaries.set(fn, cache); }
      let summary = cache.get(cacheKey);
      if (!summary) {
        summary = emptySummary();
        const inner = copyEnvironment(env);
        inner.scopes = new Map(env.scopes).set(fn, scope);
        this.activeFunctions.add(fn);
        this.awaitPolicies.push(completes);
        this.returnPolicies.push(adoptsReturn);
        try {
          let uncertain = false;
          fn.parameters.forEach((parameter, index) => {
            const supplied = index < call.arguments.length;
            const argument = argumentsAtCall[index];
            const usesDefault = !hasSpread && (!supplied || !!argument && ts.isIdentifier(argument) && argument.text === "undefined" && !symbolOf(argument)?.declarations?.length);
            if (hasSpread) {
              if (parameter.initializer) this.scan(parameter.initializer, false, inner, summary!, depth + 1);
              inner.set(parameter, undefined);
            } else if (usesDefault && parameter.initializer) {
              uncertain = this.scan(parameter.initializer, !uncertain, inner, summary!, depth + 1).mayExit || uncertain;
              inner.set(parameter, resolveArgument(parameter.initializer, inner));
            } else inner.set(parameter, argument);
          });
          const flow = this.scan(body, !uncertain, inner, summary, depth + 1);
          summary.mayStall ||= !flow.normal && !!flow.suspended && !flow.thrown && !flow.returned;
          if (adoptsReturn && ts.isArrowFunction(fn) && !ts.isBlock(body)) {
            const value = this.promiseValue(body, inner);
            if (value && ts.isCallExpression(value) && !this.returnedValue(value, inner)) {
              for (const completion of this.consumePromise(value, inner)) this.queueReturn(summary, { summary: completion, definite: !uncertain });
            }
            this.queueReturn(summary, { definite: !uncertain, rejects: nativePromiseCall(value, "reject"), stalls: neverSettles(value) });
          }
          // A raw return evaluates its operand before finally, but adopts its
          // promise only after finally completes. A throwing/stalled finally
          // must not donate the discarded promise's later setup to a catcher.
          if (adoptsReturn && !summary.mayAbort && !summary.mayStall) {
            for (const adoption of this.returnAdoptions.get(summary) ?? []) {
              this.budget.take();
              if (adoption.summary) this.merge(summary, adoption.summary, adoption.definite);
              summary.mayAbort ||= !!adoption.rejects;
              summary.mayStall ||= !!adoption.stalls;
            }
          }
        } finally { this.activeFunctions.delete(fn); this.returnPolicies.pop(); this.awaitPolicies.pop(); }
        cache.set(cacheKey, summary);
      }
      return summary;
    };
    // Preserve the allocation's invocation environment; consuming an immutable
    // promise alias later must not execute its initializer a second time.
    this.rememberPromise(call, key, env, () => summaryFor(true, true));
    const summary = summaryFor(propagates, awaited);
    // Returning an asynchronous value does not delay the wrapper's finally.
    // Keep that synchronous prefix separate from adopted promise completion.
    const synchronous = !asynchronous ? awaited ? summaryFor(true, false) : summary : undefined;
    if (synchronous) {
      const completions = this.synchronousHelpers.get(call) ?? new Map<Summary, Environment>();
      this.budget.take(env.size + (env.scopes?.size ?? 0) + 1);
      completions.set(synchronous, copyEnvironment(env));
      this.synchronousHelpers.set(call, completions);
    }
    if (awaited) {
      const completions = this.completedHelpers.get(call) ?? new Map<Summary, Environment>();
      this.budget.take(env.size + (env.scopes?.size ?? 0) + 1);
      completions.set(summary, copyEnvironment(env));
      this.completedHelpers.set(call, completions);
    }
    const needsPrefix = adoptsReturn || awaited && !callerCompletes;
    const prefix = needsPrefix ? synchronous ?? summaryFor(false, false) : summary;
    const immediate = needsPrefix ? prefix : summary;
    const aborts = propagates && summary.mayAbort, stalls = propagates && summary.mayStall;
    if (aborts) this.abortingCalls.add(call);
    if (stalls) {
      const alternatives = this.stallingHelpers.get(call) ?? new Map<Summary, Environment>();
      this.budget.take(env.size + (env.scopes?.size ?? 0) + 1);
      alternatives.set(summary, copyEnvironment(env));
      this.stallingHelpers.set(call, alternatives);
    }
    if (adoptsReturn) {
      this.queueReturn(out, { summary, definite });
      this.merge(out, prefix, definite, !asynchronous);
      return { normal: true, mayExit: !asynchronous && (prefix.mayAbort || prefix.mayStall),
        thrown: !asynchronous && prefix.mayAbort, suspended: !asynchronous && prefix.mayStall };
    }
    const catchesImportFailure = explicitAwait && this.awaitFailureCaught(call);
    this.merge(out, immediate, definite, propagates, catchesImportFailure);
    if (catchesImportFailure && (summary.imports.size > 0 || this.caughtCompletions.has(summary))) {
      // A failed awaited import cannot erase synchronous setup executed before
      // the helper suspended; its post-import completion stays gated above.
      this.merge(out, summaryFor(false, false), definite, false);
    }
    out.mayAbort ||= aborts;
    out.mayStall ||= stalls;
    return { normal: true, mayExit: aborts || stalls, thrown: aborts, suspended: stalls };
  }
  /** Resolve only an immutable, statically selected returned value. */
  private promiseValue(node: ts.Expression, env?: Environment, depth = 0): ts.Expression | undefined {
    this.budget.take();
    if (depth > 64) throw new AnalysisLimitError("Startup argument depth limit exceeded");
    const value = staticArgument(node, env);
    if (!value) return undefined;
    if (ts.isConditionalExpression(value)) {
      const truth = literalTruth(staticArgument(value.condition, env), env);
      return truth === undefined ? undefined : this.promiseValue(truth ? value.whenTrue : value.whenFalse, env, depth + 1);
    }
    if (ts.isBinaryExpression(value)) {
      const op = value.operatorToken.kind;
      if (op === ts.SyntaxKind.CommaToken) return this.promiseValue(value.right, env, depth + 1);
      const left = this.promiseValue(value.left, env, depth + 1);
      const truth = literalTruth(left, env), nullish = literalNullish(left, env);
      const right = op === ts.SyntaxKind.AmpersandAmpersandToken ? truth
        : op === ts.SyntaxKind.BarBarToken ? truth === undefined ? undefined : !truth
        : op === ts.SyntaxKind.QuestionQuestionToken ? nullish : undefined;
      if (right === undefined) return undefined;
      return right ? this.promiseValue(value.right, env, depth + 1) : left;
    }
    return value;
  }
  private rememberPromise(call: ts.CallExpression, key: string, env: Environment, complete: () => Summary): void {
    const scopes = this.promiseCompletions.get(call) ?? new Map();
    const scope = allocationScope(call, env) ?? "unknown";
    const promises = scopes.get(scope) ?? new Map();
    this.budget.take(env.size + (env.scopes?.size ?? 0) + 1);
    promises.set(key, { env: copyEnvironment(env), complete });
    scopes.set(scope, promises);
    this.promiseCompletions.set(call, scopes);
  }
  private consumePromise(value: ts.Expression | undefined, env: Environment): Summary[] {
    if (!value || !ts.isCallExpression(value)) return [];
    const result = new Set<Summary>();
    for (const origin of this.promiseCompletions.get(value)?.get(allocationScope(value, env) ?? "unknown")?.values() ?? []) {
      this.budget.take();
      if (allocationScope(value, origin.env) !== allocationScope(value, env) || !this.compatible(origin.env, env)) continue;
      result.add(origin.complete());
    }
    return [...result];
  }
  private queueReturn(summary: Summary, adoption: ReturnAdoption): void {
    this.budget.take();
    if (!adoption.summary && !adoption.rejects && !adoption.stalls) return;
    const pending = this.returnAdoptions.get(summary) ?? [];
    pending.push(adoption);
    this.returnAdoptions.set(summary, pending);
  }
  /** Runtime portions of a class, in evaluation order; instance bodies are deferred. */
  private classEvaluation(node: ts.ClassLikeDeclaration): ts.Node[] {
    // Ambient declarations are erased, including their decorator syntax.
    if (node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return [];
    const evaluated: ts.Node[] = [];
    const legacy = projectFor(node.getSourceFile())?.compilerOptions(node.getSourceFile().fileName).experimentalDecorators === true;
    const decorators = (target: ts.Node): ts.Expression[] => {
      if (!ts.canHaveDecorators(target)) return [];
      const expressions: ts.Expression[] = [];
      for (const decorator of ts.getDecorators(target) ?? []) {
        this.budget.take();
        expressions.push(decorator.expression);
      }
      return expressions;
    };
    const memberDecorators = (member: ts.ClassElement): ts.Expression[] => {
      const expressions = decorators(member);
      if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
        for (const parameter of member.parameters) { this.budget.take(); expressions.push(...decorators(parameter)); }
      }
      return expressions;
    };
    // Modern decorator expressions precede class definition. Legacy TypeScript
    // evaluates decorator factories after the constructor/static initialization.
    if (!legacy) evaluated.push(...decorators(node));
    for (const clause of node.heritageClauses ?? []) {
      this.budget.take();
      if (clause.token === ts.SyntaxKind.ExtendsKeyword) for (const type of clause.types) {
        this.budget.take();
        evaluated.push(type.expression);
      }
    }
    // All computed member keys are evaluated before static initialization.
    for (const member of node.members) {
      this.budget.take();
      if (!legacy && !ts.isConstructorDeclaration(member)) evaluated.push(...memberDecorators(member));
      if (member.name && ts.isComputedPropertyName(member.name)) evaluated.push(member.name.expression);
    }
    for (const member of node.members) {
      this.budget.take();
      if (ts.isClassStaticBlockDeclaration(member)) evaluated.push(member.body);
      else if (ts.isPropertyDeclaration(member) && member.initializer
        && member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)) evaluated.push(member.initializer);
    }
    if (legacy) {
      for (const member of node.members) {
        this.budget.take();
        if (!ts.isConstructorDeclaration(member)) evaluated.push(...memberDecorators(member));
      }
      evaluated.push(...decorators(node));
      for (const member of node.members) if (ts.isConstructorDeclaration(member)) {
        this.budget.take();
        for (const parameter of member.parameters) { this.budget.take(); evaluated.push(...decorators(parameter)); }
      }
    }
    return evaluated;
  }
  private scan(node: ts.Node, definite: boolean, env: Environment, out: Summary, depth: number): Flow {
    this.budget.take();
    if (depth > 128) throw new AnalysisLimitError("Startup expression depth limit exceeded");
    if (ts.isSourceFile(node) || ts.isBlock(node)) {
      // Static dependencies execute before the module body, regardless of the
      // import's textual position or an earlier suspended/abrupt statement.
      if (ts.isSourceFile(node)) for (const statement of node.statements) {
        if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) this.scan(statement, definite, env, out, depth + 1);
      }
      let mayExit = false, thrown = false, returned = false, suspended = false;
      for (const statement of node.statements) {
        if (ts.isSourceFile(node) && (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) continue;
        const flow = this.scan(statement, definite && !mayExit, env, out, depth + 1);
        mayExit ||= flow.mayExit; thrown ||= !!flow.thrown; returned ||= !!flow.returned; suspended ||= !!flow.suspended;
        if (!flow.normal) return { normal: false, mayExit, thrown, returned, suspended };
      }
      return { normal: true, mayExit, thrown, returned, suspended };
    }
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (!clause?.isTypeOnly && (clause?.name || !clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)
        || !clause.namedBindings.elements.length || clause.namedBindings.elements.some(e => !e.isTypeOnly))) this.addImport(out, node.getSourceFile(), node.moduleSpecifier, definite, true);
      return NORMAL;
    }
    if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.some(e => !e.isTypeOnly))) this.addImport(out, node.getSourceFile(), node.moduleSpecifier, definite, true);
      return NORMAL;
    }
    if (ts.isFunctionLike(node)) return NORMAL;
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      let flow = NORMAL;
      for (const executed of this.classEvaluation(node)) {
        if (!flow.normal) break;
        const next = this.scan(executed, definite && !flow.mayExit, env, out, depth + 1);
        flow = { normal: next.normal, mayExit: flow.mayExit || next.mayExit, thrown: flow.thrown || next.thrown, returned: flow.returned || next.returned, suspended: flow.suspended || next.suspended };
      }
      return flow;
    }
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
      const expression = node.expression ? this.scan(node.expression, definite, env, out, depth + 1) : NORMAL;
      // The return/throw completion exists only after its operand completes.
      // In particular, a pending returned await never reaches a finally block.
      if (!expression.normal) return expression;
      if (ts.isThrowStatement(node)) out.mayAbort = true;
      if (ts.isReturnStatement(node) && node.expression && this.returnPolicies.at(-1) === true && !this.returnCanBeOverridden(node, env)) {
        const value = this.promiseValue(node.expression, env);
        if (value && ts.isCallExpression(value) && !this.returnedValue(value, env)) {
          for (const completion of this.consumePromise(value, env)) this.queueReturn(out, { summary: completion, definite });
        }
        this.queueReturn(out, { definite, rejects: nativePromiseCall(value, "reject"), stalls: neverSettles(value) });
      }
      return { ...EXIT, thrown: ts.isThrowStatement(node) || expression.thrown,
        returned: ts.isReturnStatement(node), suspended: expression.suspended };
    }
    if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
      const condition = ts.isIfStatement(node) ? node.expression : node.condition;
      const conditionFlow = this.scan(condition, definite, env, out, depth + 1);
      if (!conditionFlow.normal) return conditionFlow;
      const certain = definite && !conditionFlow.mayExit;
      const combine = (flow: Flow): Flow => ({ normal: flow.normal, mayExit: conditionFlow.mayExit || flow.mayExit, thrown: conditionFlow.thrown || flow.thrown, returned: conditionFlow.returned || flow.returned, suspended: conditionFlow.suspended || flow.suspended });
      const value = literalTruth(resolveArgument(condition, env), env);
      const left = ts.isIfStatement(node) ? node.thenStatement : node.whenTrue;
      const right = ts.isIfStatement(node) ? node.elseStatement : node.whenFalse;
      if (value === true) return combine(this.scan(left, certain, env, out, depth + 1));
      if (value === false) return combine(right ? this.scan(right, certain, env, out, depth + 1) : NORMAL);
      const a = this.scan(left, false, env, out, depth + 1);
      const b = right ? this.scan(right, false, env, out, depth + 1) : NORMAL;
      return combine({ normal: a.normal || b.normal, mayExit: a.mayExit || b.mayExit, thrown: a.thrown || b.thrown, returned: a.returned || b.returned, suspended: a.suspended || b.suspended });
    }
    if (ts.isTryStatement(node)) {
      const beforeAbort = out.mayAbort;
      const body = this.scan(node.tryBlock, definite, env, out, depth + 1);
      // A provably pending await has no completion that could enter catch or
      // finally. A detached continuation may eventually enter them, but cannot
      // establish protection before its caller proceeds.
      if (!body.normal && !body.thrown && !body.returned) return body;
      const handler = node.catchClause ? this.scan(node.catchClause.block, definite && !body.suspended && !body.normal && !!body.thrown && !body.returned, env, out, depth + 1) : undefined;
      // Keep catch calls available for discovery, but an unreachable catch's
      // suspension/exit cannot change the reached finally continuation.
      const reachableHandler = body.thrown || body.mayExit && !body.returned && !body.suspended ? handler : undefined;
      if (handler) out.mayAbort = beforeAbort || !!reachableHandler?.thrown;
      const suspended = !!body.suspended || !!reachableHandler?.suspended;
      const beforeFinallyAbort = out.mayAbort;
      out.mayAbort = beforeAbort;
      const final = node.finallyBlock ? this.scan(node.finallyBlock, definite && !suspended, env, out, depth + 1) : NORMAL;
      // An abrupt finally completion replaces the preceding return/throw.
      // Abort evidence from earlier statements outside this try still applies.
      if (!final.normal) return { ...final, suspended: suspended || final.suspended };
      out.mayAbort ||= beforeFinallyAbort;
      const uncaught = handler ? !!reachableHandler?.thrown : !!body.thrown;
      const returned = !!body.returned || !!reachableHandler?.returned || !!final.returned;
      const unknownExit = body.mayExit && !body.thrown && !body.returned;
      return { normal: final.normal && (body.normal || !!reachableHandler?.normal),
        mayExit: returned || uncaught || !!final.thrown || unknownExit || suspended || !!final.suspended,
        thrown: uncaught || final.thrown, returned, suspended: suspended || final.suspended };
    }
    if (ts.isAwaitExpression(node)) {
      const inner = this.scan(node.expression, definite, env, out, depth + 1);
      const value = this.promiseValue(node.expression, env);
      const completions = value && ts.isCallExpression(value) && !directlyAwaited(value, this.budget)
        ? this.consumePromise(value, env) : [];
      for (const completion of completions) {
        const alternatives = this.awaitedValues.get(node) ?? new Map<Summary, Environment>();
        this.budget.take(env.size + (env.scopes?.size ?? 0) + 1);
        alternatives.set(completion, copyEnvironment(env));
        this.awaitedValues.set(node, alternatives);
        if (this.awaitPolicies.at(-1) === true) this.merge(out, completion, definite, true, this.awaitFailureCaught(node));
      }
      const aborts = completions.some(completion => completion.mayAbort);
      const stalls = completions.some(completion => completion.mayStall);
      out.mayAbort ||= aborts;
      out.mayStall ||= stalls;
      if (nativePromiseCall(value, "reject")) {
        out.mayAbort = true;
        return { normal: false, mayExit: true, thrown: true, suspended: this.awaitPolicies.at(-1) === false };
      }
      if (neverSettles(value)) return { normal: false, mayExit: true, suspended: true };
      // Detached setup and a module's top-level await both suspend before
      // their continuation. A later listener can prove that continuation was
      // reached, but its registrations cannot protect an earlier listener.
      // Explicitly awaited helper startup retains its successful summary.
      if (this.awaitPolicies.at(-1) !== true) return { normal: true, mayExit: true, suspended: true };
      return { ...inner, mayExit: inner.mayExit || aborts || stalls,
        thrown: inner.thrown || aborts, suspended: inner.suspended || stalls };
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
      const leftFlow = this.scan(node.left, definite, env, out, depth + 1);
      if (!leftFlow.normal) return leftFlow;
      const left = staticArgument(node.left, env);
      const value = literalTruth(left, env);
      const operator = node.operatorToken.kind;
      const execute = operator === ts.SyntaxKind.AmpersandAmpersandToken ? value : operator === ts.SyntaxKind.BarBarToken ? value === undefined ? undefined : !value : literalNullish(left, env);
      const rightFlow = execute !== false ? this.scan(node.right, definite && !leftFlow.mayExit && execute === true, env, out, depth + 1) : NORMAL;
      // An unknown guard has a normal short-circuit path even if evaluating
      // the other path never resumes or completes abruptly.
      return { normal: execute !== true || rightFlow.normal, mayExit: leftFlow.mayExit || rightFlow.mayExit, thrown: leftFlow.thrown || rightFlow.thrown, returned: leftFlow.returned || rightFlow.returned, suspended: leftFlow.suspended || rightFlow.suspended };
    }
    if (ts.isWhileStatement(node) && literalTruth(resolveArgument(node.expression, env), env) === false) {
      return this.scan(node.expression, definite, env, out, depth + 1);
    }
    if (ts.isForStatement(node) && node.condition && literalTruth(resolveArgument(node.condition, env), env) === false) {
      if (node.initializer) this.scan(node.initializer, definite, env, out, depth + 1);
      return this.scan(node.condition, definite, env, out, depth + 1);
    }
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isSwitchStatement(node)) {
      ts.forEachChild(node, child => { this.scan(child, false, env, out, depth + 1); });
      return { normal: true, mayExit: true };
    }
    if (ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) {
      const flow = this.scan(node.expression, definite, env, out, depth + 1);
      if (!flow.normal) return flow;
      // An earlier optional segment also guards later nonoptional keys in the
      // same chain. Its receiver evaluation itself remains unconditional.
      const receivers = optionalReceivers(node).map(receiver => staticArgument(receiver, env));
      if (receivers.some(isNullish)) return flow;
      if (ts.isElementAccessExpression(node)) {
        const conditional = receivers.some(receiver => !definitelyPresent(receiver));
        const key = this.scan(node.argumentExpression, definite && !flow.mayExit && !conditional, env, out, depth + 1);
        return { normal: conditional || key.normal, mayExit: flow.mayExit || key.mayExit, thrown: flow.thrown || key.thrown, returned: flow.returned || key.returned, suspended: flow.suspended || key.suspended };
      }
      return flow;
    }
    if (ts.isCallExpression(node)) {
      const optional = optionalReceivers(node);
      const optionalValues = optional.map(receiver => staticArgument(receiver, env));
      const skipped = optionalValues.findIndex(isNullish);
      if (skipped >= 0) return this.scan(optional[skipped], definite, env, out, depth + 1);
      const expressionFlow = this.scan(node.expression, definite, env, out, depth + 1);
      if (!expressionFlow.normal) return expressionFlow;
      let uncertain = expressionFlow.mayExit;
      let suspended = !!expressionFlow.suspended;
      let thrown = !!expressionFlow.thrown;
      const optionalUnknown = optionalValues.some(value => !definitelyPresent(value));
      for (const arg of node.arguments) {
        const argumentFlow = this.scan(arg, definite && !uncertain && !optionalUnknown, env, out, depth + 1);
        if (!argumentFlow.normal) return { ...argumentFlow, normal: optionalUnknown,
          mayExit: uncertain || argumentFlow.mayExit, suspended: suspended || argumentFlow.suspended };
        uncertain ||= argumentFlow.mayExit;
        suspended ||= !!argumentFlow.suspended;
        thrown ||= !!argumentFlow.thrown;
      }
      const certain = definite && !uncertain && !optionalUnknown;
      out.possibleCalls.add(node);
      if (certain) out.calls.add(node);
      this.recordBindings(out, node, env, certain);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const awaited = directlyAwaited(node, this.budget)
          || this.returnPolicies.at(-1) === true && this.returnedValue(node, env);
        this.addImport(out, node.getSourceFile(), resolveArgument(node.arguments[0], env), certain && awaited && this.awaitPolicies.at(-1) === true);
        const specifier = resolveArgument(node.arguments[0], env);
        if (specifier && ts.isStringLiteralLike(specifier)) {
          const project = projectFor(node.getSourceFile());
          const rel = project?.resolve(node.getSourceFile().fileName, specifier.text);
          const dependency = rel && project?.sources.get(rel);
          if (dependency) {
            const completion = emptySummary();
            completion.imports.set(dependency, true);
            this.markCompletedImport(completion, dependency);
            if (certain && awaited && this.awaitPolicies.at(-1) === true) this.markCompletedImport(out, dependency, !directlyAwaited(node, this.budget) || !this.awaitFailureCaught(node));
            const key = [...env].map(([parameter, value]) => this.id(parameter) + "=" + this.id(value)).join(",");
            this.rememberPromise(node, key, env, () => completion);
          }
        }
        if (awaited && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
          const project = projectFor(node.getSourceFile());
          const rel = project?.resolve(node.getSourceFile().fileName, node.arguments[0].text);
          const dependency = rel && project?.sources.get(rel);
          if (dependency) this.awaitedImports.set(node, dependency);
        }
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === "require" && !symbolOf(node.expression)?.declarations?.length) {
        const specifier = resolveArgument(node.arguments[0], env);
        this.addImport(out, node.getSourceFile(), specifier, certain);
        if (specifier && ts.isStringLiteralLike(specifier)) {
          const project = projectFor(node.getSourceFile());
          const rel = project?.resolve(node.getSourceFile().fileName, specifier.text);
          const dependency = rel && project?.sources.get(rel);
          if (dependency) {
            if (certain) this.prepareRequiredSource(dependency);
            const required = this.summaries.get(dependency);
            const flow = this.sourceFlows.get(dependency);
            // In-progress CommonJS cycles return partial exports. Once a
            // complete source flow is available, its throw cannot be ignored
            // as an optional import edge while following code is trusted.
            if (flow) {
              const exits = !!flow.thrown || !!flow.suspended || flow.mayExit && !flow.returned;
              out.mayAbort ||= !!required?.mayAbort;
              out.mayStall ||= !!required?.mayStall;
              if (!flow.normal && !flow.returned) return { ...flow, normal: optionalUnknown,
                mayExit: uncertain || exits, suspended: suspended || flow.suspended };
              uncertain ||= exits;
              thrown ||= !!flow.thrown;
              suspended ||= !!flow.suspended;
            } else if (!required && !this.activeRequiredSources?.has(dependency)) {
              // Only uncertain execution can leave a resolved source unscanned;
              // it must not establish setup through unknown completion.
              out.mayAbort = true; uncertain = true; thrown = true;
            }
          }
        }
      }
      const expression = resolveArgument(node.expression, env);
      const fn = expression && callableDefinition(expression);
      if (fn) {
        const invoked = this.invoke(fn, node, env, out, certain, depth + 1);
        uncertain ||= invoked.mayExit;
        thrown ||= !!invoked.thrown;
        suspended ||= !!invoked.suspended;
      }
      return { normal: true, mayExit: uncertain, thrown, suspended };
    }
    let flow = NORMAL;
    ts.forEachChild(node, child => {
      if (!flow.normal) return;
      const next = this.scan(child, definite && !flow.mayExit, env, out, depth + 1);
      flow = { normal: next.normal, mayExit: flow.mayExit || next.mayExit, thrown: flow.thrown || next.thrown, returned: flow.returned || next.returned, suspended: flow.suspended || next.suspended };
    });
    if (flow.normal && (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      || ts.isDeleteExpression(node)
      || (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator))) {
      this.recordBindings(out, node, env, definite && !flow.mayExit);
    }
    return flow;
  }
}

/** A shared union view avoids copying the same call set into every entry. */
class UnionSet<T> implements ReadonlySet<T> {
  constructor(private sets: readonly ReadonlySet<T>[], private budget: AnalysisBudget) {}
  get size(): number { return [...this].length; }
  has(value: T): boolean {
    for (const set of this.sets) { this.budget.take(); if (set.has(value)) return true; }
    return false;
  }
  *values(): SetIterator<T> {
    const seen = new Set<T>();
    for (const set of this.sets) for (const value of set) {
      this.budget.take();
      if (!seen.has(value)) { seen.add(value); yield value; }
    }
  }
  keys(): SetIterator<T> { return this.values(); }
  *entries(): SetIterator<[T, T]> { for (const value of this) yield [value, value]; }
  [Symbol.iterator](): SetIterator<T> { return this.values(); }
  forEach(callback: (value: T, key: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    for (const value of this) callback.call(thisArg, value, value, this);
  }
}
function staticArgument(node: ts.Expression | undefined, env?: Environment, seen = new Set<ts.Node>()): ts.Expression | undefined {
  const value = resolveArgument(node, env);
  if (!value || seen.has(value)) return undefined;
  if (seen.size > 64) throw new AnalysisLimitError("Startup argument depth limit exceeded");
  seen.add(value);
  if (ts.isIdentifier(value)) {
    const declaration = symbolOf(value)?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const && !written(declaration)) return staticArgument(declaration.initializer, env, seen);
  }
  return value;
}
function nativePromiseCall(node: ts.Expression | undefined, method: string): boolean {
  return !!node && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === method && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === "Promise" && !symbolOf(node.expression.expression)?.declarations?.length;
}
function neverSettles(node: ts.Expression | undefined): boolean {
  if (!node || !ts.isNewExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "Promise"
    || symbolOf(node.expression)?.declarations?.length) return false;
  const executor = node.arguments?.[0];
  return !!executor && (ts.isArrowFunction(executor) || ts.isFunctionExpression(executor))
    && ts.isBlock(executor.body) && executor.body.statements.length === 0;
}
function isNullish(node: ts.Expression | undefined): boolean {
  return !!node && (node.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(node) || ts.isIdentifier(node) && node.text === "undefined" && !symbolOf(node)?.declarations?.length);
}
function definitelyPresent(node: ts.Expression | undefined): boolean {
  return !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isObjectLiteralExpression(node)
    || ts.isArrayLiteralExpression(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node));
}
function optionalReceivers(call: ts.CallExpression | ts.PropertyAccessExpression | ts.ElementAccessExpression): ts.Expression[] {
  const receivers: ts.Expression[] = call.questionDotToken ? [call.expression] : [];
  let node = call.expression;
  while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) {
    if (node.questionDotToken) receivers.push(node.expression);
    node = node.expression;
  }
  return receivers;
}

function asyncPromise(node: ts.Expression, env?: Environment): boolean {
  if (!ts.isCallExpression(node) || optionalReceivers(node).some(receiver => !definitelyPresent(staticArgument(receiver, env)))) return false;
  const callee = resolveArgument(node.expression, env);
  const fn = callee && callableDefinition(callee);
  return !!fn?.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword);
}
function literalNullish(node: ts.Expression | undefined, env?: Environment): boolean | undefined {
  if (!node) return undefined;
  if (asyncPromise(node, env)) return false;
  if (isNullish(node)) return true;
  if (definitelyPresent(node) || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function literalTruth(node: ts.Expression | undefined, env?: Environment): boolean | undefined {
  if (!node) return undefined;
  if (asyncPromise(node, env)) return true;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword || isNullish(node)) return false;
  if (ts.isNumericLiteral(node)) return Number(node.text) !== 0;
  if (ts.isStringLiteralLike(node)) return node.text.length !== 0;
  return undefined;
}
function isTransparentExpression(node: ts.Node): node is ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression | ts.SatisfiesExpression | ts.TypeAssertion {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
    || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node);
}
/** Ascend only runtime-erased wrappers around the same returned value. */
function directlyAwaited(node: ts.Expression, budget: AnalysisBudget): boolean {
  let value: ts.Node = node;
  while (value.parent && isTransparentExpression(value.parent) && value.parent.expression === value) {
    budget.take();
    value = value.parent;
  }
  return !!value.parent && ts.isAwaitExpression(value.parent);
}
function resolveArgument(node: ts.Expression | undefined, env?: Environment, seen = new Set<ts.Node>()): ts.Expression | undefined {
  if (!node || seen.has(node)) return undefined;
  if (seen.size > 64) throw new AnalysisLimitError("Startup argument depth limit exceeded");
  seen.add(node);
  if (isTransparentExpression(node)) return resolveArgument(node.expression, env, seen);
  const declaration = ts.isIdentifier(node) ? symbolOf(node)?.valueDeclaration : undefined;
  if (declaration && ts.isParameter(declaration)) return !written(declaration) && env?.has(declaration) ? resolveArgument(env.get(declaration), env, seen) : undefined;
  // Follow immutable aliases while the same invocation environment is available.
  // Mutable bindings stay intact so receiver identity can retain alias snapshots.
  if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
    && declaration.parent.flags & ts.NodeFlags.Const && !written(declaration)) {
    const resolved = resolveArgument(declaration.initializer, env, seen);
    return resolved ?? (env ? undefined : node);
  }
  return node;
}

// Reassignment makes a declaration insufficient evidence of the callable used
// at startup. Index writes once per immutable source, rather than per call site.
const writes = new WeakMap<ts.SourceFile, Set<ts.Declaration>>();
/** Property declarations alone are not callable identity: an escaped receiver
 * can have that member replaced without a write to its original symbol. */
function stableCallableMethod(method: ts.MethodDeclaration): boolean {
  const owner = method.parent;
  const receiver = ts.isObjectLiteralExpression(owner) || ts.isClassExpression(owner) ? owner
    : ts.isClassDeclaration(owner) ? owner.name : undefined;
  if (!receiver) return false;
  const source = method.getSourceFile();
  const facts = collectionFacts(source, new AnalysisBudget("Startup callable receivers", projectWorkLimit([source])), true);
  return !facts.unsafe.has(receiver);
}
function written(declaration: ts.Declaration): boolean {
  const sf = declaration.getSourceFile();
  let found = writes.get(sf);
  if (!found) {
    found = new Set();
    const pending: ts.Node[] = [sf];
    const budget = new AnalysisBudget("Startup callable writes", projectWorkLimit([sf]));
    while (pending.length) {
      budget.take();
      const node = pending.pop()!;
      const target = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? node.left
        : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) ? node.operand : undefined;
      if (target) {
        const symbol = symbolOf(target);
        const d = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
        if (d) found.add(d);
      }
      ts.forEachChild(node, child => { pending.push(child); });
    }
    writes.set(sf, found);
  }
  return found.has(declaration);
}
function callableDefinition(node: ts.Node, seen = new Set<ts.Node>()): ts.FunctionLikeDeclaration | undefined {
  if (seen.has(node)) return undefined;
  if (seen.size > 64) throw new AnalysisLimitError("Startup callable depth limit exceeded");
  seen.add(node);
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return written(node) || ts.isMethodDeclaration(node) && !stableCallableMethod(node) ? undefined : node;
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return callableDefinition(node.expression, seen);
  if (ts.isVariableDeclaration(node)) {
    if (!(node.parent.flags & ts.NodeFlags.Const) || !node.initializer || written(node)) return undefined;
    return callableDefinition(node.initializer, seen);
  }
  const declaration = definitionOf(node);
  return declaration && declaration !== node ? callableDefinition(declaration, seen) : undefined;
}

export function knownCallback(node: ts.Expression | undefined): boolean {
  const fn = node && callableDefinition(node);
  return !!fn && !fn.asteriskToken;
}
export function processEvent(call: ts.CallExpression, events: readonly string[], context?: StartupContext): boolean {
  if (!ts.isPropertyAccessExpression(call.expression) || !["on", "once", "addListener"].includes(call.expression.name.text)) return false;
  if (context) return context.invocationsFor(call, true).some(view => processEventInvocation(call, events, view));
  return processEventInvocation(call, events);
}
function processEventInvocation(call: ts.CallExpression, events: readonly string[], context?: StartupContext): boolean {
  const expr = call.expression;
  if (!ts.isPropertyAccessExpression(expr) || !["on", "once", "addListener"].includes(expr.name.text)) return false;
  const receiver = context ? context.resolveExpression(expr.expression, call) : expr.expression;
  if (!receiver) return false;
  const imported = importedBinding(receiver);
  const native = ts.isIdentifier(receiver) && receiver.text === "process" && !symbolOf(receiver)?.declarations?.length
    || !!imported && /^(node:)?process$/.test(imported.module) && ["default", "*"].includes(imported.name);
  const event = context ? context.resolveExpression(call.arguments[0], call) : call.arguments[0];
  const callback = call.arguments[1] && (context ? context.resolveExpression(call.arguments[1], call) : call.arguments[1]);
  return native && !!event && ts.isStringLiteralLike(event) && events.includes(event.text) && knownCallback(callback);
}
export function dependencies(pkg: Record<string, unknown>): Record<string, unknown> {
  return { ...(isRecord(pkg.dependencies) ? pkg.dependencies : {}), ...(isRecord(pkg.devDependencies) ? pkg.devDependencies : {}) };
}
export function serviceContexts(root: string, ws: Workspace): ServiceContexts {
  return new ServiceContexts(root, ws);
}
