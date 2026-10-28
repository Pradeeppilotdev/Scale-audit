import { definitionOf, importedBinding, projectFor, symbolOf } from "../bindings.js";
import { dependencies, knownCallback, processEvent, serviceContexts, type StartupContext } from "../serviceContext.js";
import ts from "typescript";
import { AnalysisBudget, AnalysisLimitError, projectWorkLimit } from "../analysisBudget.js";
import { lineOf, snippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";
import { Workspace } from "../workspace.js";

const HEALTH_PATH = /^\/(?:api\/)?(health|healthz|live|ready|readiness)(?:\/|$)/i;
const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "use", "route", "head", "options"]);

export async function detectLifecycle(root: string, ws?: Workspace): Promise<Finding[]> {
  const out: Finding[] = [];

  const workspace = ws ?? (await Workspace.load(root));
  const contexts = serviceContexts(root, workspace);
  const identities = new ReceiverIdentities(workspace);
  const units = new Map(workspace.units.map(unit => [unit.sf, unit]));
  for (const startup of contexts.entryContexts()) {
    for (const listen of startup.possibleListeners) {
      if (!startup.invocationsFor(listen).some(view => isListenCall(listen, view, identities))) continue;
      const unit = units.get(listen.getSourceFile());
      if (!unit) continue;
      const deps = dependencies(await contexts.manifest(unit));
      const hasServerFramework = ["express", "fastify", "@nestjs/core", "koa", "@hapi/hapi", "next"].some(name => !!deps[name]);
      const serverFile = { ...unit, line: lineOf(unit.sf, listen) };
      const listenerViews = startup.invocationsFor(listen).filter(view => isListenCall(listen, view, identities));
      const ambiguousReceiver = ts.isPropertyAccessExpression(listen.expression) && !startup.resolveExpression(listen.expression.expression, listen);
      const hasHealthRoute = listenerViews.every(view => hasHttpHealthRoute(view, listen, identities) || hasNestHealthRoute(view, listen, identities));
      const hasShutdownHandler = listenerViews.every(listenerView => {
        // Iterate lazily: a local signal handler need not enumerate all shared
        // imported calls, and proof must retain this listener's invocation.
        for (const call of listenerView.protectionCallsFor(listen)) {
          if (processEvent(call, ["SIGTERM", "SIGINT"], listenerView)
            || ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "enableShutdownHooks"
              && listenerView.invocationsFor(call, true).some(view => ts.isPropertyAccessExpression(call.expression) && ts.isPropertyAccessExpression(listen.expression)
                && identities.same(view, call.expression.expression, call, listen.expression.expression, listen, listenerView)
                && isNestCreation(identities.resolve(listenerView, listen.expression.expression, listen)))) return true;
        }
        return false;
      });

      if (!hasHealthRoute && hasServerFramework) {
        out.push(
          makeFinding({
            id: "missing-health-endpoint",
            category: "Observability",
            severity: "low",
            confidence: ambiguousReceiver ? "low" : "medium",
            file: serverFile.rel,
            line: serverFile.line,
            message: "No health/liveness endpoint found in this service’s visible startup graph.",
            scaleTrigger: "Load balancers/orchestrators cannot detect unhealthy instances, causing bad traffic routing during incidents.",
            suggestedFix: "Add GET /health (liveness) and GET /ready (readiness) with a cheap DB/queue check for readiness.",
            snippet: snippetAt(serverFile.content, serverFile.line),
          }),
        );
      }

      if (!hasShutdownHandler) {
        out.push(
          makeFinding({
            id: "missing-graceful-shutdown",
            category: "Resilience",
            severity: "medium",
            confidence: ambiguousReceiver ? "low" : "medium",
            file: serverFile.rel,
            line: serverFile.line,
            message: "No SIGTERM/SIGINT shutdown handler was established for this server’s visible startup path.",
            scaleTrigger: "On deploys/scale-down, in-flight requests fail and DB/connection cleanup is skipped.",
            suggestedFix: "Handle SIGTERM: stop accepting connections, drain in-flight requests with a timeout, then close DB/queue clients.",
            snippet: snippetAt(serverFile.content, serverFile.line),
          }),
        );
      }

    }
  }
  return out;
}

/** Server detection remains conservative for conventional app/server receivers. */
function isListenCall(call: ts.CallExpression, startup: StartupContext, identities: ReceiverIdentities): boolean {
  const expr = call.expression;
  const receiver = ts.isPropertyAccessExpression(expr) ? startup.resolveExpression(expr.expression, call) : undefined;
  if (!ts.isPropertyAccessExpression(expr) || expr.name.text !== "listen") return false;
  if (receiver) {
    const allocation = identities.resolve(startup, expr.expression, call);
    if (allocation !== undefined || isServerReceiver(receiver, undefined, expr.expression)) {
      return isServerReceiver(receiver, allocation, expr.expression);
    }
    // Uncertainty removes identity proof, but a field that visibly held a
    // server still establishes a possible listener. Use its declared factory
    // only for discovery; route matching never receives that stale allocation.
    const declaration = directDeclaration(expr.expression);
    if ((declaration && (ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration))) && declaration.initializer) {
      const possible = startup.resolveExpression(declaration.initializer, call) ?? declaration.initializer;
      return isServerReceiver(possible, possible, expr.expression);
    }
    return false;
  }
  // A reused helper can have several possible server arguments. Ambiguity
  // removes protection proof, but must not erase the potential listener.
  const declaration = definitionOf(expr.expression);
  return !!declaration && ts.isParameter(declaration);
}

const SERVER_RECEIVER = /^(app|router|server|srv|http_?server|https_?server|fastify|api|backend|instance|node)$/i;
function isServerReceiver(node: ts.Expression, allocation: ts.Node | undefined, original: ts.Expression = node): boolean {
  if (allocation) {
    if (isNestCreation(allocation)) return true;
    if (ts.isNewExpression(allocation) && /^(Map|Set|WeakMap|WeakSet)$/.test(allocation.expression.getText())) return false;
    if (ts.isCallExpression(allocation) || ts.isNewExpression(allocation)) {
      const expression = allocation.expression;
      const direct = importedBinding(expression);
      const receiver = ts.isPropertyAccessExpression(expression) ? importedBinding(expression.expression) : null;
      const imported = direct ?? (receiver && ["*", "default"].includes(receiver.name) && ts.isPropertyAccessExpression(expression)
        ? { module: receiver.module, name: expression.name.text } : null);
      if (imported && ["express", "fastify", "koa"].includes(imported.module)
        && ["default", "*"].includes(imported.name)) return true;
      if (imported && ["http", "node:http", "https", "node:https"].includes(imported.module)
        && (ts.isCallExpression(allocation) && imported.name === "createServer"
          || ts.isNewExpression(allocation) && imported.name === "Server")) return true;
    }
  }
  // Resolving immutable aliases may replace `app` with an opaque factory call.
  // Keep its written receiver or initializer binding's conventional-name hint
  // for discovery only, including when that binding was passed to a helper.
  // Allocation identity and protection proof still use the resolved value.
  const initializerBinding = ts.isVariableDeclaration(node.parent) && node.parent.initializer === node ? node.parent.name : undefined;
  return [node, original, initializerBinding].some(receiver => !!receiver && SERVER_RECEIVER.test(receiver.getText().split(".").at(-1) ?? ""));
}

interface ReceiverWrite { node: ts.BinaryExpression; value?: ts.Expression }
interface IdentityTrace { depth: number; snapshots: ReadonlyMap<ts.Node, ReadonlySet<ts.Node>> }
interface PropertyWrite { node: ts.Node; receiver: ts.Expression; key?: string; value?: ts.Expression }
function propertyKey(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  return ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
}
function statementAt(node: ts.Node): ts.Node {
  while (node.parent && !ts.isBlock(node.parent) && !ts.isSourceFile(node.parent)) node = node.parent;
  return node;
}
function enclosingFunction(node: ts.Node): ts.Node | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) if (ts.isFunctionLike(parent)) return parent;
  return undefined;
}
function directDeclaration(node: ts.Node): ts.Declaration | undefined {
  const symbol = symbolOf(node);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  return declaration && ts.isVariableDeclaration(declaration) ? declaration : definitionOf(node);
}

/** Allocation identity at a visible use; declaration names alone are not instances. */
class ReceiverIdentities {
  private writes = new Map<ts.Declaration, ReceiverWrite[]>();
  private propertyWrites = new Map<string, PropertyWrite[]>();
  private budget: AnalysisBudget;
  private memberWrites: { receiver: ts.Expression; node: ts.Node }[] = [];
  private mutatedAllocations = new WeakMap<StartupContext, Map<ts.Node, { node: ts.Node; scope: string | undefined }[]>>();
  constructor(workspace: Workspace) {
    this.budget = new AnalysisBudget("Service receiver identity", projectWorkLimit(workspace.units.map(unit => unit.sf)));
    for (const unit of workspace.units) {
      const pending: ts.Node[] = [unit.sf];
      while (pending.length) {
        this.budget.take();
        const node = pending.pop()!;
        if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
          const declaration = directDeclaration(node.left);
          if (declaration) {
            const entries = this.writes.get(declaration) ?? [];
            entries.push({ node, value: node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? node.right : undefined });
            this.writes.set(declaration, entries);
          }
        }
        const writtenMember = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? node.left
          : ts.isDeleteExpression(node) ? node.expression
          : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) ? node.operand : undefined;
        if (writtenMember && (ts.isPropertyAccessExpression(writtenMember) || ts.isElementAccessExpression(writtenMember))) {
          const key = propertyKey(writtenMember);
          const entries = this.propertyWrites.get(key ?? "*") ?? [];
          entries.push({ node, receiver: writtenMember.expression, key,
            value: ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? node.right : undefined });
          this.propertyWrites.set(key ?? "*", entries);
        }
        let member = writtenMember;
        while (member && (ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member))) {
          this.budget.take();
          this.memberWrites.push({ receiver: member.expression, node });
          member = member.expression;
        }
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          if (["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"].includes(node.expression.name.text)) {
            let receiver: ts.Expression = node.expression.expression;
            this.memberWrites.push({ receiver, node });
            while (ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver)) {
              this.budget.take();
              receiver = receiver.expression;
              this.memberWrites.push({ receiver, node });
            }
          }
          if (node.expression.expression.getText() === "Object" && !symbolOf(node.expression.expression)?.declarations?.length
            && ["assign", "defineProperty", "defineProperties"].includes(node.expression.name.text) && node.arguments[0]) {
            this.memberWrites.push({ receiver: node.arguments[0], node });
            const entries = this.propertyWrites.get("*") ?? [];
            entries.push({ node, receiver: node.arguments[0] });
            this.propertyWrites.set("*", entries);
          }
        }
        ts.forEachChild(node, child => { pending.push(child); });
      }
    }
    for (const entries of this.writes.values()) entries.sort((a, b) => a.node.pos - b.node.pos);
    for (const entries of this.propertyWrites.values()) entries.sort((a, b) => a.node.pos - b.node.pos);
  }
  metadataUnmodified(allocation: ts.Node, startup: StartupContext, use?: ts.Node, capturedAt?: ts.Node): boolean {
    let mutated = this.mutatedAllocations.get(startup);
    if (!mutated) {
      mutated = new Map();
      this.mutatedAllocations.set(startup, mutated);
      for (const write of this.memberWrites) {
        this.budget.take();
        if (!startup.sources.has(write.node.getSourceFile())) continue;
        // Only mutations reached by this entry count. Each helper invocation
        // supplies its own argument bindings and allocation scope.
        for (const view of startup.invocationsFor(write.node)) {
          this.budget.take();
          const value = this.resolve(view, write.receiver, write.node);
          if (!value) continue;
          const effects = mutated.get(value) ?? [];
          effects.push({ node: write.node, scope: view.allocationScope(value, write.node) });
          mutated.set(value, effects);
        }
      }
    }
    const effects = mutated.get(allocation);
    if (!effects) return true;
    // Decorator expressions are inspected as metadata rather than executed
    // calls; retain the listener view's lexical helper scope for those uses.
    const scope = startup.allocationScope(allocation, use) ?? startup.allocationScope(allocation);
    // An unresolved instance cannot establish unchanged metadata when a
    // visible mutation could target that same allocation.
    return !effects.some(effect => {
      this.budget.take();
      // A spread copies an array's elements, and @Module captures the current
      // metadata property values. Later lexical writes cannot change a copy.
      // Cross-function/file ordering remains conservative.
      if (capturedAt && effect.node.getSourceFile() === capturedAt.getSourceFile()
        && enclosingFunction(effect.node) === enclosingFunction(capturedAt) && effect.node.pos >= capturedAt.end) return false;
      return scope === undefined || effect.scope === undefined || effect.scope === scope;
    });
  }
  resolve(startup: StartupContext, expression: ts.Expression, call: ts.Node): ts.Node | undefined {
    // Decorators are not executed call sites in the startup summary. Preserve
    // the concrete listener view's captured helper environment for their args.
    const bound = startup.resolveExpression(expression, call) ?? startup.resolveExpression(expression);
    return bound ? this.value(bound, bound, { depth: 0, snapshots: new Map() }, startup, call) : undefined;
  }
  resolveAt(startup: StartupContext, expression: ts.Expression, call: ts.Node, snapshot: ts.Node): ts.Node | undefined {
    const bound = startup.resolveExpression(expression, call) ?? startup.resolveExpression(expression);
    if (!bound) return undefined;
    // A direct read can be evaluated at class completion by legacy decorators.
    // Earlier immutable aliases retain their own initializer capture position.
    const direct = bound.getSourceFile() === expression.getSourceFile()
      && bound.pos >= expression.pos && bound.end <= expression.end;
    return this.value(bound, direct ? snapshot : bound, { depth: 0, snapshots: new Map() }, startup, call);
  }
  private value(node: ts.Node, use: ts.Node, seen: IdentityTrace, startup?: StartupContext, site?: ts.Node): ts.Node | undefined {
    this.budget.take();
    // Revisiting a constructor through an earlier alias capture is legitimate;
    // only the same node at the same snapshot forms a resolution cycle.
    const uses = seen.snapshots.get(node);
    if (uses?.has(use)) return undefined;
    if (seen.depth > 128) throw new AnalysisLimitError("Service receiver identity depth limit exceeded");
    this.budget.take(uses?.size ?? 0);
    const snapshots = new Map(seen.snapshots);
    snapshots.set(node, new Set([...(uses ?? []), use]));
    const next: IdentityTrace = { depth: seen.depth + 1, snapshots };
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isAwaitExpression(node) || ts.isSatisfiesExpression(node)) return this.value(node.expression, use, next, startup, site);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const receiver = startup?.resolveExpression(node.expression, site) ?? startup?.resolveExpression(node.expression) ?? node.expression;
      const directReceiver = receiver.getSourceFile() === node.expression.getSourceFile()
        && receiver.pos >= node.expression.pos && receiver.end <= node.expression.end;
      const object = this.value(receiver, directReceiver ? use : receiver, next, startup, site);
      const key = propertyKey(node);
      if (object && ts.isObjectLiteralExpression(object) && key !== undefined) {
        let selected: ts.Expression | undefined;
        for (const property of object.properties) {
          this.budget.take();
          if (ts.isSpreadAssignment(property) || !property.name || ts.isComputedPropertyName(property.name)) { selected = undefined; continue; }
          const name = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name) ? property.name.text : undefined;
          if (name === key) selected = ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
        }
        let selectedContext = startup, selectedSite = site;
        // A property read captures the value at this lexical access, not the
        // object's original initializer forever. Alias initializers retain
        // their own use position, so an old alias stays on the old allocation.
        if (startup) {
          const candidates = [...(this.propertyWrites.get(key) ?? []), ...(this.propertyWrites.get("*") ?? [])]
            .sort((a, b) => a.node.pos - b.node.pos);
          for (const write of candidates) {
            this.budget.take();
            if (!startup.sources.has(write.node.getSourceFile()) || write.key !== undefined && write.key !== key) continue;
            const sameLexical = write.node.getSourceFile() === use.getSourceFile()
              && enclosingFunction(write.node) === enclosingFunction(use);
            if (sameLexical && write.node.end > use.pos) continue;
            for (const view of startup.invocationsFor(write.node)) {
              this.budget.take();
              if (sameLexical) {
                const invocation = startup.allocationScope(write.node, site) ?? startup.allocationScope(write.node);
                const writeInvocation = view.allocationScope(write.node, write.node);
                if (invocation !== undefined && writeInvocation !== undefined && invocation !== writeInvocation) continue;
              }
              const boundReceiver = view.resolveExpression(write.receiver, write.node) ?? view.resolveExpression(write.receiver);
              const target = boundReceiver && this.value(boundReceiver, write.receiver, next, view, write.node);
              if (target !== object) continue;
              const scope = startup.allocationScope(object, site) ?? startup.allocationScope(object);
              const writeScope = view.allocationScope(object, write.node);
              if (scope !== undefined && writeScope !== undefined && scope !== writeScope) continue;
              // Only a direct assignment in the same reached lexical block
              // selects a replacement. Conditional/helper/dynamic writes remove
              // proof rather than retaining a stale allocation.
              const statement = statementAt(use);
              if (!sameLexical || !write.value || write.key === undefined
                || !ts.isExpressionStatement(write.node.parent) || write.node.parent.parent !== statement.parent) return undefined;
              selected = view.resolveExpression(write.value, write.node) ?? write.value;
              selectedContext = view;
              selectedSite = write.node;
            }
          }
        }
        return selected ? this.value(selected, selected, next, selectedContext, selectedSite) : undefined;
      }
      // A property declaration describes the original shape, not the current
      // value of an unresolved receiver. In particular, an invalidated inner
      // object must not regain its old identity through the outer property's
      // initializer. Namespace exports still resolve to their actual variable
      // or class declaration rather than an object-owned property declaration.
      const declaration = directDeclaration(node);
      if (!declaration || ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration)
        || ts.isShorthandPropertyAssignment(declaration)) return undefined;
      return this.value(declaration, use, next, startup, site);
    }
    if (ts.isIdentifier(node)) {
      const declaration = directDeclaration(node);
      if (!declaration) return undefined;
      return this.value(declaration, use, next, startup, site);
    }
    if (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) {
      return node.initializer ? this.value(node.initializer, node.initializer, next, startup, site) : undefined;
    }
    if (ts.isShorthandPropertyAssignment(node)) return this.value(node.name, use, next, startup, site);
    if (ts.isVariableDeclaration(node)) {
      let initializer = node.initializer;
      for (const write of this.writes.get(node) ?? []) {
        this.budget.take();
        if (write.node.getSourceFile() !== use.getSourceFile() || enclosingFunction(write.node) !== enclosingFunction(use)
          || enclosingFunction(write.node) !== enclosingFunction(node)) return undefined;
        if (write.node.end > use.pos) continue;
        if (!write.value || !ts.isExpressionStatement(write.node.parent)
          || write.node.parent.parent !== node.parent.parent.parent) return undefined;
        initializer = write.value;
      }
      return initializer ? this.value(initializer, initializer, next, startup, site) : undefined;
    }
    if (ts.isClassDeclaration(node)) {
      // The declaration is the original constructor allocation; an identifier
      // or property initializer captures the binding at its own use position.
      // Later assignments must not erase an already captured constructor.
      let replacement: ts.Expression | undefined;
      let selectedContext = startup, selectedSite = site;
      for (const write of this.writes.get(node) ?? []) {
        this.budget.take();
        if (startup && !startup.sources.has(write.node.getSourceFile())) continue;
        const sameLexical = write.node.getSourceFile() === use.getSourceFile()
          && enclosingFunction(write.node) === enclosingFunction(use);
        if (sameLexical && write.node.end > use.pos) continue;
        const alternatives = startup ? startup.invocationsFor(write.node) : [undefined];
        for (const view of alternatives) {
          this.budget.take();
          if (startup && view) {
            const scope = startup.allocationScope(node, site) ?? startup.allocationScope(node);
            const writeScope = view.allocationScope(node, write.node);
            if (scope !== undefined && writeScope !== undefined && scope !== writeScope) continue;
          }
          if (!sameLexical || !write.value || !ts.isExpressionStatement(write.node.parent)
            || write.node.parent.parent !== statementAt(use).parent) return undefined;
          replacement = view?.resolveExpression(write.value, write.node) ?? write.value;
          selectedContext = view ?? startup;
          selectedSite = write.node;
        }
      }
      return replacement ? this.value(replacement, replacement, next, selectedContext, selectedSite) : node;
    }
    // Parameters without a unique argument and returned factories do not prove
    // allocation identity across independent calls.
    return ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isStringLiteralLike(node) ? node : undefined;
  }
  same(startup: StartupContext, a: ts.Expression, aCall: ts.CallExpression, b: ts.Expression, bCall: ts.CallExpression, other: StartupContext = startup): boolean {
    const left = this.resolve(startup, a, aCall), right = this.resolve(other, b, bCall);
    return left !== undefined && left === right
      && startup.allocationScope(left, aCall) !== undefined
      && startup.allocationScope(left, aCall) === other.allocationScope(right!, bCall);
  }
}
function isNestCreation(node: ts.Node | undefined): node is ts.CallExpression {
  if (!node || !ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "create") return false;
  const factory = importedBinding(node.expression.expression);
  return factory?.module === "@nestjs/core" && factory.name === "NestFactory";
}
function hasHttpHealthRoute(startup: StartupContext, listen: ts.CallExpression, identities: ReceiverIdentities): boolean {
  if (!ts.isPropertyAccessExpression(listen.expression)) return false;
  const budget = new AnalysisBudget("HTTP health routes");
  const receivers: { expression: ts.Expression; call: ts.CallExpression; context: StartupContext }[] = [{ expression: listen.expression.expression, call: listen, context: startup }];
  const seenReceivers = new Set<ts.Node>();
  const allocation = identities.resolve(startup, listen.expression.expression, listen);
  if (allocation) seenReceivers.add(allocation);
  const protection = startup.protectionCallsFor(listen);
  // Preserve the receiver, route and callback from each concrete invocation.
  // Combining alternatives independently could invent a route on another app.
  for (let index = 0; index < receivers.length; index++) {
    for (const call of protection) {
      budget.take();
      if (!ts.isPropertyAccessExpression(call.expression) || !ROUTE_METHODS.has(call.expression.name.text)) continue;
      for (const view of startup.invocationsFor(call, true)) {
        budget.take();
        if (!ts.isPropertyAccessExpression(call.expression)
          || !identities.same(view, call.expression.expression, call, receivers[index].expression, receivers[index].call, receivers[index].context)) continue;
        const first = call.arguments[0] && view.resolveExpression(call.arguments[0], call);
        if (ROUTE_METHODS.has(call.expression.name.text) && first && ts.isStringLiteralLike(first)
          && HEALTH_PATH.test(first.text) && call.arguments.slice(1).some(argument => knownCallback(view.resolveExpression(argument, call)))) return true;
        // Non-root prefixes need path composition; do not claim an endpoint without it.
        if (call.expression.name.text === "use") {
          const rootMount = first && ts.isStringLiteralLike(first) ? first.text === "/" : true;
          if (rootMount) for (const expression of call.arguments) {
            const bound = view.resolveExpression(expression, call);
            if (!bound || ts.isStringLiteralLike(bound) || knownCallback(bound)) continue;
            const value = identities.resolve(view, expression, call);
            if (!value || seenReceivers.has(value)) continue;
            seenReceivers.add(value);
            receivers.push({ expression, call, context: view });
          }
        }
      }
    }
  }
  return false;
}

function nestDecorator(node: ts.Node, names: string[]): ts.CallExpression | undefined {
  if (!ts.canHaveDecorators(node)) return undefined;
  return ts.getDecorators(node)?.map(d => d.expression).find((expr): expr is ts.CallExpression => {
    if (!ts.isCallExpression(expr)) return false;
    const binding = importedBinding(expr.expression);
    return binding?.module === "@nestjs/common" && names.includes(binding.name);
  });
}
function literalPath(call: ts.CallExpression, startup: StartupContext, identities: ReceiverIdentities, budget: AnalysisBudget): string | undefined {
  const arg = call.arguments[0];
  let legacySnapshot: ts.Node | undefined;
  if (projectFor(call.getSourceFile())?.compilerOptions(call.getSourceFile().fileName).experimentalDecorators === true) {
    for (let parent: ts.Node | undefined = call.parent; parent; parent = parent.parent) {
      budget.take();
      if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) {
        legacySnapshot = parent.getLastToken();
        break;
      }
    }
  }
  const resolve = (node: ts.Expression, seen = new Set<ts.Node>()): string | undefined => {
    budget.take();
    if (seen.has(node)) return undefined;
    if (seen.size > 64) throw new AnalysisLimitError("Nest route literal depth limit exceeded");
    const next = new Set(seen).add(node);
    const bound = startup.resolveExpression(node);
    if (bound && bound !== node) return resolve(bound, next);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return resolve(node.expression, next);
    if (ts.isStringLiteralLike(node)) return node.text;
    // Property reads and their aliases capture the value at the argument's
    // evaluation point. Reuse receiver identity's owner/write handling rather
    // than following a property's original initializer after it was replaced.
    const direct = arg && node.getSourceFile() === arg.getSourceFile() && node.pos >= arg.pos && node.end <= arg.end;
    const value = direct && legacySnapshot ? identities.resolveAt(startup, node, node, legacySnapshot)
      : identities.resolve(startup, node, node);
    return value && ts.isStringLiteralLike(value) ? value.text : undefined;
  };
  return arg ? resolve(arg) : "";
}
interface MetadataValue { node: ts.Node; evaluatedAt?: ts.Node }
function withinExpression(node: ts.Node, expression: ts.Node): boolean {
  return node.getSourceFile() === expression.getSourceFile() && node.pos >= expression.pos && node.end <= expression.end;
}
function legacyMetadataSnapshot(call: ts.CallExpression | undefined, budget: AnalysisBudget): ts.Node | undefined {
  if (!call || projectFor(call.getSourceFile())?.compilerOptions(call.getSourceFile().fileName).experimentalDecorators !== true) return undefined;
  for (let parent: ts.Node | undefined = call.parent; parent; parent = parent.parent) {
    budget.take();
    if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) return parent.getLastToken();
  }
  return undefined;
}
/** Resolve metadata at its use, preserving object spread capture/override order. */
function metadataProperties(startup: StartupContext, expression: ts.Expression | undefined, call: ts.Node, identities: ReceiverIdentities,
  budget: AnalysisBudget, evaluatedAt?: ts.Node, seen = new Set<ts.Node>()): Map<string, MetadataValue | undefined> {
  budget.take();
  const object = expression && (evaluatedAt ? identities.resolveAt(startup, expression, call, evaluatedAt) : identities.resolve(startup, expression, call));
  const result = new Map<string, MetadataValue | undefined>();
  // Inline legacy decorator expressions execute after class initialization.
  // A prebuilt object keeps its earlier field captures, while its current
  // property values are read at the decorator/spread evaluation point.
  const decorator = call?.parent;
  const capturedAt = evaluatedAt ?? (decorator && ts.isDecorator(decorator)
    && (ts.isClassDeclaration(decorator.parent) || ts.isClassExpression(decorator.parent)) ? decorator.parent : call);
  if (!object || !ts.isObjectLiteralExpression(object) || !identities.metadataUnmodified(object, startup, call, capturedAt)) { result.set("*", undefined); return result; }
  if (seen.has(object)) { result.set("*", undefined); return result; }
  if (seen.size > 64) throw new AnalysisLimitError("Nest health metadata depth limit exceeded");
  const next = new Set(seen).add(object);
  const objectEvaluation = expression && withinExpression(object, expression) ? evaluatedAt : undefined;
  const invalidate = () => { budget.take(result.size); result.clear(); result.set("*", undefined); };
  for (const property of object.properties) {
    budget.take();
    if (ts.isSpreadAssignment(property)) {
      for (const [key, value] of metadataProperties(startup, property.expression, property, identities, budget, objectEvaluation, next)) {
        budget.take();
        if (key === "*") invalidate(); else result.set(key, value);
      }
      continue;
    }
    if (!property.name || ts.isComputedPropertyName(property.name)) { invalidate(); continue; }
    const key = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name) ? property.name.text : undefined;
    if (key === undefined) { invalidate(); continue; }
    const value = ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
    result.set(key, value ? { node: value, evaluatedAt: objectEvaluation } : undefined);
  }
  return result;
}
function hasNestHealthRoute(startup: StartupContext, listen: ts.CallExpression, identities: ReceiverIdentities): boolean {
  const budget = new AnalysisBudget("Nest health metadata");
  const pending: { node: ts.Node; capturedAt?: ts.Node; evaluatedAt?: ts.Node }[] = [];
  const creation = ts.isPropertyAccessExpression(listen.expression) ? identities.resolve(startup, listen.expression.expression, listen) : undefined;
  if (isNestCreation(creation) && startup.possibleCalls.has(creation) && creation.arguments[0]) pending.push({ node: startup.resolveExpression(creation.arguments[0]) ?? creation.arguments[0] });
  const seen = new Map<ts.Node, Map<ts.Node | undefined, Set<ts.Node | undefined>>>();
  while (pending.length) {
    budget.take();
    const { node, capturedAt, evaluatedAt } = pending.pop()!;
    // One array can be reached as both a live reference and a spread snapshot.
    // The same source node has different mutation cutoffs along those paths.
    const evaluations = seen.get(node) ?? new Map<ts.Node | undefined, Set<ts.Node | undefined>>();
    const captures = evaluations.get(evaluatedAt) ?? new Set<ts.Node | undefined>();
    if (captures.has(capturedAt)) continue;
    budget.take();
    captures.add(capturedAt);
    evaluations.set(evaluatedAt, captures);
    seen.set(node, evaluations);
    const push = (next: ts.Node, capture = capturedAt, evaluation: ts.Node | null = evaluatedAt ?? null) => pending.push({ node: next, capturedAt: capture, evaluatedAt: evaluation ?? undefined });
    if (ts.isArrayLiteralExpression(node)) { if (identities.metadataUnmodified(node, startup, listen, capturedAt)) for (const element of node.elements) push(element); continue; }
    if (ts.isSpreadElement(node)) { push(node.expression, evaluatedAt ?? node); continue; }
    if (ts.isVariableDeclaration(node) && node.initializer && node.parent.flags & ts.NodeFlags.Const) { push(node.initializer, capturedAt, null); continue; }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) { push(node.expression); continue; }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      // Metadata classes and arrays can arrive through a property read or an immutable
      // alias of that read. Resolve its captured allocation in this listener's
      // invocation, retaining the existing live-reference/spread mutation cutoff.
      // Do not consume a property's raw initializer when identity is uncertain.
      const value = evaluatedAt ? identities.resolveAt(startup, node, node, evaluatedAt) : identities.resolve(startup, node, node);
      if (value && (ts.isArrayLiteralExpression(value) || ts.isClassDeclaration(value))) { push(value, capturedAt, withinExpression(value, node) ? evaluatedAt ?? null : null); continue; }
      // A mutable class binding must not regain its original declaration after
      // capture resolution rejected or replaced it.
      const declaration = definitionOf(node);
      if (declaration && ts.isClassDeclaration(declaration)) continue;
    }
    if (!ts.isClassDeclaration(node)) {
      if (ts.isExpression(node)) {
        const bound = startup.resolveExpression(node);
        if (bound && bound !== node) { push(bound, capturedAt, withinExpression(bound, node) ? evaluatedAt ?? null : null); continue; }
      }
      const declaration = definitionOf(node);
      if (declaration && declaration !== node) push(declaration);
      continue;
    }
    const module = nestDecorator(node, ["Module"]);
    const metadata = module?.arguments[0];
    const properties = metadataProperties(startup, metadata, module!, identities, budget, legacyMetadataSnapshot(module, budget));
    for (const key of ["imports", "controllers"]) {
      const value = properties.get(key);
      if (value) pending.push({ node: value.node, evaluatedAt: value.evaluatedAt });
    }
    const controller = nestDecorator(node, ["Controller"]);
    if (!controller) continue;
    const prefix = literalPath(controller, startup, identities, budget);
    if (prefix === undefined) continue;
    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member) || !member.body) continue;
      const route = nestDecorator(member, ["Get", "Head", "All"]);
      if (!route) continue;
      const suffix = literalPath(route, startup, identities, budget);
      if (suffix !== undefined && HEALTH_PATH.test("/" + [prefix, suffix].map(s => s.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/"))) return true;
    }
  }
  return false;
}
