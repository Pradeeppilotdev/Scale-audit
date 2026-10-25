import { constructionCalls, executionLifetimes } from "./executionLifetimes.js";
import ts from "typescript";
import { definitionOf, importedBinding, symbolOf, projectFor } from "./bindings.js";
import { staticExpression as resolve, staticProperty, staticProperties, staticArray, isUnknownStaticValue, staticToken as token, type StaticToken as Token } from "./staticValues.js";
import { AnalysisBudget, projectWorkLimit } from "./analysisBudget.js";
import { requestEvidence } from "./requestEvidence.js";
import type { Workspace } from "./workspace.js";
import type { ProviderLifetime } from "./lifetimes.js";

type Api = "awilix" | "inversify" | "tsyringe";
type Scope = "singleton" | "container" | "resolution" | "transient" | "unknown";
type Mode = "classic" | "proxy" | "unknown";
interface Container { api: Api; key: ts.Node | string; parent?: Container; fresh: boolean; defaultScope: Scope; mode: Mode }
interface Selection { name?: Token; tagKey?: Token; tagValue?: Token; unknown?: boolean }
interface Dependency extends Selection { token: Token; all?: boolean }
interface Registration extends Selection { container: Container; token: Token; owner?: ts.Node; alias?: Token; scope: Scope; mode: Mode; implicit?: boolean; site?: ts.Node; cacheOrigin?: ts.Node; guarded?: boolean; fallback?: boolean; uncertain?: boolean }
interface Resolution extends Selection { container: Container; token: Token; site: ts.Node; all: boolean }

/** Imported APIs, active registrations and visible request call paths only. Target code is never executed. */
export function containerLifetimes(workspace: Workspace): Map<ts.Node, ProviderLifetime> {
  const budget = new AnalysisBudget("DI lifetime", projectWorkLimit(workspace.units.map(unit => unit.sf)));
  const prop = (node: ts.Node | undefined, name: string) => staticProperty(node, name, budget);
  const result = new Map<ts.Node, ProviderLifetime>();
  const registrations = new Map<Container, Map<Token, Registration[]>>();
  const calls: ts.CallExpression[] = [];
  const cradleResolutions: ts.PropertyAccessExpression[] = [];
  const resolutions: Resolution[] = [];
  const containers = new Map<ts.Node, Container>();
  const global: Container = { api: "tsyringe", key: "tsyringe-global", fresh: false, defaultScope: "transient", mode: "proxy" };
  const request = requestEvidence(workspace);
  const initialExecution = executionLifetimes(workspace, new Map());
  const referencedFunctions = new Set<ts.Node>(), factoryOwners = new Set<ts.Node>();
  const enclosingFunction = (site: ts.Node) => {
    for (let parent = site.parent; parent; parent = parent.parent) if (ts.isFunctionLike(parent)) return parent;
    return undefined;
  };
  const exportedFunction = (node: ts.Node): boolean => {
    if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) return true;
    const variable = ts.isVariableDeclaration(node.parent) ? node.parent : undefined;
    const statement = variable?.parent.parent;
    return !!statement && ts.isVariableStatement(statement) && !!ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
  };
  for (const { sf } of workspace.units) {
    const pending: ts.Node[] = [sf];
    while (pending.length) {
      budget.take(); const node = pending.pop()!;
      if (ts.isIdentifier(node)) {
        const definition = definitionOf(node);
        const target = definition && ts.isVariableDeclaration(definition) ? definition.initializer : definition;
        if (target && ts.isFunctionLike(target) && target.name !== node && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)) referencedFunctions.add(target);
      }
      ts.forEachChild(node, child => { pending.push(child); });
    }
  }
  const imported = (node: ts.Node | undefined, api: string, name: string) => { const binding = node && importedBinding(node); return binding?.module === api && binding.name === name; };
  const scopeOf = (node: ts.Node | undefined, fallback: Scope, api: Api): Scope => {
    if (!node) return fallback;
    const value = resolve(node);
    if (value && ts.isNumericLiteral(value) && api === "tsyringe") return (["transient", "singleton", "resolution", "container"] as Scope[])[Number(value.text)] ?? "unknown";
    if (value && ts.isPropertyAccessExpression(value)) {
      const binding = importedBinding(value.expression);
      if (!binding || !((binding.module === api && binding.name === "Lifetime") || (binding.module === api && binding.name === "Lifecycle"))) return "unknown";
    }
    const text = value && (ts.isStringLiteralLike(value) ? value.text : ts.isPropertyAccessExpression(value) ? value.name.text : "");
    return text && ({ SINGLETON: "singleton", Singleton: "singleton", singleton: "singleton", SCOPED: "container", ContainerScoped: "container", TRANSIENT: "transient", Transient: "transient", transient: "transient", Request: "resolution", ResolutionScoped: "resolution" } as Record<string, Scope>)[text] || "unknown";
  };
  const modeOf = (node: ts.Node | undefined, fallback: Mode): Mode => {
    if (!node) return fallback;
    const value = resolve(node);
    if (value && ts.isPropertyAccessExpression(value) && imported(value.expression, "awilix", "InjectionMode")) return value.name.text === "CLASSIC" ? "classic" : value.name.text === "PROXY" ? "proxy" : "unknown";
    return value && ts.isStringLiteralLike(value) ? value.text === "CLASSIC" ? "classic" : value.text === "PROXY" ? "proxy" : "unknown" : "unknown";
  };
  const container = (node: ts.Node | undefined, seen = new Set<ts.Node>()): Container | undefined => {
    budget.take();
    if (!node) return undefined;
    if (seen.has(node) || seen.size > 64) throw new Error("Container expression recursion limit exceeded");
    if (imported(node, "tsyringe", "container")) return global;
    const value = resolve(node);
    if (!value) return undefined;
    const cached = containers.get(value); if (cached) return cached;
    const next = new Set(seen).add(node);
    let found: Container | undefined;
    if (ts.isCallExpression(value) && imported(value.expression, "awilix", "createContainer")) found = { api: "awilix", key: value, fresh: request(value), defaultScope: "transient", mode: modeOf(prop(value.arguments[0], "injectionMode"), "proxy") };
    if (ts.isNewExpression(value) && imported(value.expression, "inversify", "Container")) found = { api: "inversify", key: value, fresh: request(value), parent: container(prop(value.arguments?.[0], "parent"), next), defaultScope: scopeOf(prop(value.arguments?.[0], "defaultScope"), "transient", "inversify"), mode: "proxy" };
    if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)) {
      const parent = container(value.expression.expression, next);
      const method = value.expression.name.text;
      if (parent && ((parent.api === "awilix" && method === "createScope") || (parent.api === "tsyringe" && method === "createChildContainer"))) found = { ...parent, key: value, parent, fresh: parent.fresh || request(value) };
      else if (parent && ((parent.api === "awilix" && method === "register") || (parent.api === "tsyringe" && /^(register|registerSingleton|registerInstance)$/.test(method)))) found = parent;
    }
    if (found) containers.set(value, found);
    return found;
  };
  const merge = (owner: ts.Node | undefined, lifetime: ProviderLifetime) => {
    if (!owner) return;
    const rank = { singleton: 0, transient: 1, unknown: 2, request: 3 };
    const old = result.get(owner); if (!old || rank[lifetime.kind] > rank[old.kind]) result.set(owner, lifetime);
  };
  const add = (c: Container, key: Token, owner: ts.Node | undefined, scope: Scope, options: Selection & { implicit?: boolean; alias?: Token; mode?: Mode; site?: ts.Node; cacheOrigin?: ts.Node; uncertain?: boolean } = {}) => {
    budget.take();
    const siteOwner = options.site && enclosingFunction(options.site);
    if (siteOwner && !request(options.site!) && !initialExecution.has(siteOwner) && !factoryOwners.has(siteOwner)) {
      if (!referencedFunctions.has(siteOwner) && !exportedFunction(siteOwner)) return;
      options = { ...options, uncertain: true }; scope = "unknown";
    }
    if (owner && ts.isFunctionLike(owner)) factoryOwners.add(owner);
    if (owner && !(ts.isClassDeclaration(owner) || ts.isClassExpression(owner) || ts.isFunctionLike(owner))) return;
    const byToken = registrations.get(c) ?? new Map<Token, Registration[]>();
    const previous = byToken.get(key) ?? [];
    budget.take(previous.length);
    const entry: Registration = { ...options, container: c, token: key, owner, scope, mode: options.mode ?? c.mode };
    // TSyringe retains multiple registrations for resolveAll; ordinary resolve uses the last.
    byToken.set(key, options.implicit ? previous.length ? previous : [entry] : c.api === "awilix" ? [...previous.filter(r => options.uncertain || r.uncertain), entry] : [...previous.filter(r => !r.implicit), entry]);
    registrations.set(c, byToken);
  };
  const awilixResolver = (c: Container, expression: ts.Node): { owner?: ts.Node; scope: Scope; mode: Mode; alias?: Token } | undefined => {
    let current = resolve(expression); let scope: Scope | undefined; let mode: Mode | undefined;
    const seen = new Set<ts.Node>();
    while (current && ts.isCallExpression(current) && !seen.has(current)) {
      budget.take(); seen.add(current);
      if (imported(current.expression, "awilix", "asClass") || imported(current.expression, "awilix", "asFunction")) return {
        owner: resolve(current.arguments[0]), scope: scope ?? scopeOf(prop(current.arguments[1], "lifetime"), "transient", "awilix"), mode: mode ?? modeOf(prop(current.arguments[1], "injectionMode"), c.mode),
      };
      if (imported(current.expression, "awilix", "aliasTo") && current.arguments[0]) return { scope: "transient", mode: c.mode, alias: token(current.arguments[0]) };
      if (ts.isPropertyAccessExpression(current.expression)) {
        const method = current.expression.name.text;
        scope ??= method === "singleton" ? "singleton" : method === "scoped" ? "container" : method === "transient" ? "transient" : method === "setLifetime" ? scopeOf(current.arguments[0], "unknown", "awilix") : undefined;
        mode ??= method === "classic" ? "classic" : method === "proxy" ? "proxy" : method === "setInjectionMode" ? modeOf(current.arguments[0], "unknown") : undefined;
        current = resolve(current.expression.expression); continue;
      }
      break;
    }
    return undefined;
  };
  const awilix = (c: Container, key: Token, expression: ts.Node, site: ts.Node) => {
    const resolver = awilixResolver(c, expression);
    if (resolver) add(c, key, resolver.owner, resolver.scope, { alias: resolver.alias, mode: resolver.mode, site });
  };
  for (const { sf } of workspace.units) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) calls.push(node);
      if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "cradle") cradleResolutions.push(node);
      if (ts.isClassDeclaration(node) && ts.canHaveDecorators(node)) for (const decorator of [...(ts.getDecorators(node) ?? [])].sort((a, b) => {
        const scoped = (d: ts.Decorator) => ts.isCallExpression(d.expression) && (imported(d.expression.expression, "tsyringe", "singleton") || imported(d.expression.expression, "tsyringe", "scoped"));
        return Number(scoped(b)) - Number(scoped(a));
      })) {
        const d = decorator.expression;
        if (!ts.isCallExpression(d)) continue;
        if (imported(d.expression, "tsyringe", "singleton")) add(global, node, node, "singleton", { implicit: true, site: node });
        else if (imported(d.expression, "tsyringe", "scoped")) add(global, node, node, scopeOf(d.arguments[0], "unknown", "tsyringe"), { implicit: true, site: node });
        else if (imported(d.expression, "tsyringe", "injectable")) {
          add(global, node, node, "transient", { implicit: true, site: node });
          const tokens = prop(d.arguments[0], "token");
          for (const key of tokens ? (resolve(tokens)?.kind === ts.SyntaxKind.ArrayLiteralExpression) ? staticArray(tokens, new Set(), budget) : [tokens] : []) add(global, token(key), node, "transient", { implicit: true, site: node });
        }
      }
      ts.forEachChild(node, visit);
    }; visit(sf);
  }
  for (const call of calls) {
    budget.take();
    if (!ts.isPropertyAccessExpression(call.expression)) continue;
    const method = call.expression.name.text;
    const c = container(call.expression.expression);
    if (c?.api === "awilix" && method === "register") {
      const object = resolve(call.arguments[0]);
      if (object && ts.isObjectLiteralExpression(object)) for (const [key, value] of staticProperties(object, budget)) {
        if (key !== "*") awilix(c, `string:${key}`, value, call);
      }
      else if (call.arguments[0] && call.arguments[1]) awilix(c, token(call.arguments[0]), call.arguments[1], call);
    }
    if (c?.api === "tsyringe" && /^(register|registerSingleton|registerInstance)$/.test(method) && call.arguments[0]) {
      const key = token(call.arguments[0]); const provider = call.arguments[1];
      if (method === "registerSingleton") {
        const target = resolve(provider ?? call.arguments[0]);
        add(c, key, target && (ts.isClassDeclaration(target) || ts.isClassExpression(target)) ? target : undefined, "singleton", provider && !(target && (ts.isClassDeclaration(target) || ts.isClassExpression(target))) ? { alias: token(provider), site: call } : { site: call });
      } else if (method === "registerInstance") add(c, key, undefined, "singleton", { site: call });
      else {
        let owner = resolve(prop(provider, "useClass") ?? prop(provider, "useFactory") ?? provider);
        let scope = scopeOf(prop(call.arguments[2], "lifecycle"), "transient", "tsyringe");
        let cacheOrigin: ts.Node | undefined;
        if (owner && ts.isCallExpression(owner) && (imported(owner.expression, "tsyringe", "instanceCachingFactory") || imported(owner.expression, "tsyringe", "instancePerContainerCachingFactory"))) { cacheOrigin = owner; scope = imported(owner.expression, "tsyringe", "instanceCachingFactory") ? "singleton" : "container"; owner = resolve(owner.arguments[0]); }
        const alias = prop(provider, "useToken");
        if (alias) add(c, key, undefined, scope, { alias: token(alias), site: call });
        else add(c, key, owner, scope, { site: call, cacheOrigin });
      }
    }
    // Only terminal fluent binding calls establish the completed Inversify binding.
    if (ts.isPropertyAccessExpression(call.parent) && ts.isCallExpression(call.parent.parent)) continue;
    let current: ts.Node | undefined = call; let scope: Scope | undefined; let owner: ts.Node | undefined; let self = false; let alias: Token | undefined; const selection: Selection = {};
    const seen = new Set<ts.Node>();
    while (current && ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression) && !seen.has(current)) {
      budget.take(); seen.add(current);
      const name = current.expression.name.text;
      scope ??= name === "inSingletonScope" ? "singleton" : name === "inTransientScope" ? "transient" : name === "inRequestScope" ? "resolution" : undefined;
      if (/^(whenNamed|whenTargetNamed)$/.test(name) && current.arguments[0]) selection.name = token(current.arguments[0]);
      else if (/^(whenTagged|whenTargetTagged)$/.test(name) && current.arguments[0] && current.arguments[1]) { selection.tagKey = token(current.arguments[0]); selection.tagValue = token(current.arguments[1]); }
      else if (name.startsWith("when") && !/^(whenDefault|whenTargetIsDefault)$/.test(name)) selection.unknown = true;
      if (name === "toSelf") self = true;
      if (name === "to" || name === "toDynamicValue") owner = resolve(current.arguments[0]);
      if (name === "toService" && current.arguments[0]) alias = token(current.arguments[0]);
      if (name === "bind") { const target = container(current.expression.expression); if (target?.api === "inversify" && current.arguments[0]) add(target, token(current.arguments[0]), self ? resolve(current.arguments[0]) : owner, scope ?? target.defaultScope, { ...selection, alias, site: call }); break; }
      current = current.expression.expression;
    }
  }
  const guardedRegistration = (r: Registration): boolean => {
    if (!r.site) return false;
    for (let ancestor = r.site.parent; ancestor && !ts.isFunctionLike(ancestor); ancestor = ancestor.parent) {
      if (!ts.isIfStatement(ancestor) || !ts.isPrefixUnaryExpression(ancestor.expression) || ancestor.expression.operator !== ts.SyntaxKind.ExclamationToken) continue;
      let branch = r.site; while (branch.parent && branch.parent !== ancestor) branch = branch.parent;
      if (branch !== ancestor.thenStatement) continue;
      let yields = false;
      const inspectYield = (node: ts.Node) => { if (ts.isFunctionLike(node)) return; if (ts.isAwaitExpression(node)) yields = true; ts.forEachChild(node, inspectYield); };
      inspectYield(ancestor.thenStatement); if (yields) continue;
      const condition = ancestor.expression.operand;
      if (ts.isCallExpression(condition) && ts.isPropertyAccessExpression(condition.expression) && condition.expression.name.text === "isRegistered" && condition.arguments[0]
        && container(condition.expression.expression) === r.container && token(condition.arguments[0]) === r.token) return true;
      if (!ts.isIdentifier(condition)) continue;
      const declaration = definitionOf(condition);
      if (!declaration || !ts.isVariableDeclaration(declaration)) continue;
      let outer: ts.Node | undefined = declaration.parent; while (outer && !ts.isFunctionLike(outer)) outer = outer.parent;
      if (outer) continue;
      let initialized = false;
      const inspect = (node: ts.Node) => {
        budget.take(); if (ts.isFunctionLike(node)) return;
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.right.kind === ts.SyntaxKind.TrueKeyword
          && definitionOf(node.left) === declaration && node.getStart() > r.site!.getStart()) initialized = true;
        ts.forEachChild(node, inspect);
      };
      inspect(ancestor.thenStatement); if (initialized) return true;
    }
    return false;
  };
  const requestExecution = (site: ts.Node): boolean => {
    if (request(site)) return true;
    for (let parent = site.parent; parent; parent = parent.parent) if (ts.isFunctionLike(parent)) return result.get(parent)?.kind === "request" || !!result.get(parent)?.requestConsumer;
    return false;
  };
  const registrationFresh = (r: Registration): boolean => {
    if (r.cacheOrigin) return requestExecution(r.cacheOrigin);
    if (r.site && r.container.api !== "awilix" && requestExecution(r.site)) {
      r.guarded ??= guardedRegistration(r); return !r.guarded;
    }
    return false;
  };
  const baseline = (r: Registration) => merge(r.owner, { kind: r.unknown || r.scope === "unknown" ? "unknown" : (r.scope === "singleton" || r.scope === "container") && !r.container.fresh && !registrationFresh(r) ? "singleton" : "transient" });
  for (const byToken of registrations.values()) for (const entries of byToken.values()) {
    let active: Registration | undefined;
    for (const entry of entries) { budget.take(); if (entry.uncertain) baseline(entry); else active = entry; }
    if (active) baseline(active);
  }
  const automatic = new Map<Container, Map<Token, Registration>>();
  const lookup = (c: Container, key: Token, all = false, selection: Selection = {}): Registration[] => {
    for (let level: Container | undefined = c; level; level = level.parent) {
      budget.take();
      const entries = registrations.get(level)?.get(key);
      if (!entries?.length) continue;
      if (c.api !== "inversify") {
        if (all) return entries;
        const possible: Registration[] = []; let active: Registration | undefined;
        for (const entry of entries) { budget.take(); if (entry.uncertain) possible.push(entry); else active = entry; }
        if (active) possible.push(active);
        return possible;
      }
      const matches = entries.filter(entry => {
        budget.take();
        return selection.unknown || entry.unknown || entry.name === selection.name && entry.tagKey === selection.tagKey && entry.tagValue === selection.tagValue;
      });
      if (selection.unknown || !all && matches.length > 1) return matches.map(entry => ({ ...entry, scope: "unknown" }));
      return matches;
    }
    if (c.api === "tsyringe" && typeof key !== "string" && (ts.isClassDeclaration(key) || ts.isClassExpression(key))) {
      const constructor = key.members.find(ts.isConstructorDeclaration);
      if (!constructor?.parameters.length) {
        const byToken = automatic.get(c) ?? new Map();
        let entry = byToken.get(key);
        if (!entry) { entry = { container: c, token: key, owner: key, scope: "transient", mode: c.mode, fallback: true }; byToken.set(key, entry); automatic.set(c, byToken); }
        return [entry];
      }
    }
    return [];
  };
  const selectionFor = (options: ts.Node | undefined): Selection => {
    const name = prop(options, "name"), tag = prop(options, "tag");
    const tagKey = prop(tag, "key"), tagValue = prop(tag, "value");
    if ([name, tag, tagKey, tagValue].some(value => value && isUnknownStaticValue(value))) return { unknown: true };
    return { name: name ? token(name) : undefined, tagKey: tagKey ? token(tagKey) : undefined, tagValue: tagValue ? token(tagValue) : undefined };
  };
  const dependencyCache = new Map<Registration, Dependency[]>();
  const dependencies = (registration: Registration): Dependency[] => {
    const cached = dependencyCache.get(registration); if (cached) return cached;
    const owner = registration.owner;
    if (!owner) return [];
    const isClass = ts.isClassDeclaration(owner) || ts.isClassExpression(owner);
    const constructor = isClass ? owner.members.find(ts.isConstructorDeclaration) : undefined;
    const parameters = isClass ? constructor?.parameters ?? [] : ts.isFunctionLike(owner) ? owner.parameters : [];
    const keys: Dependency[] = [];
    const key = (token: Token, all = false, selection: Selection = {}) => keys.push({ token, all, ...selection });
    const decorated = (node: ts.Node): boolean => {
      let explicit = false;
      for (const decorator of ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : []) {
        const d = decorator.expression;
        if (ts.isCallExpression(d) && d.arguments[0]) {
          const api = registration.container.api;
          const all = imported(d.expression, api, api === "tsyringe" ? "injectAll" : "multiInject");
          if (all || imported(d.expression, api, "inject")) {
            const selection: Selection = {};
            for (const other of ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : []) {
              if (!ts.isCallExpression(other.expression)) continue;
              const metadata = other.expression;
              if (imported(metadata.expression, "inversify", "named") && metadata.arguments[0]) selection.name = token(metadata.arguments[0]);
              if (imported(metadata.expression, "inversify", "tagged") && metadata.arguments[0] && metadata.arguments[1]) { selection.tagKey = token(metadata.arguments[0]); selection.tagValue = token(metadata.arguments[1]); }
            }
            key(token(d.arguments[0]), all, selection); explicit = true;
          }
        }
      }
      return explicit;
    };
    for (const parameter of parameters) {
      const explicit = decorated(parameter);
      const metadata = projectFor(owner.getSourceFile())?.compilerOptions(owner.getSourceFile().fileName);
      const emittedInversify = registration.container.api === "inversify" && metadata?.emitDecoratorMetadata === true && ts.canHaveDecorators(owner)
        && ts.getDecorators(owner)?.some(decorator => ts.isCallExpression(decorator.expression) && imported(decorator.expression.expression, "inversify", "injectable"));
      if (!explicit && (registration.container.api === "tsyringe" || emittedInversify) && parameter.type && ts.isTypeReferenceNode(parameter.type)) key(token(parameter.type.typeName));
      if (registration.container.api === "awilix") {
        if (registration.mode === "classic" && ts.isIdentifier(parameter.name)) key(`string:${parameter.name.text}`);
        if (registration.mode === "proxy" && ts.isObjectBindingPattern(parameter.name)) for (const element of parameter.name.elements) {
          const name = element.propertyName ?? element.name;
          if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) key(`string:${name.text}`);
        }
      }
    }
    if (isClass && registration.container.api === "inversify") for (const member of owner.members) if (ts.isPropertyDeclaration(member)) decorated(member);
    if (registration.container.api === "awilix" && registration.mode === "proxy" && parameters[0] && ts.isIdentifier(parameters[0].name)) {
      const binding = symbolOf(parameters[0].name);
      const visit = (node: ts.Node) => {
        budget.take();
        if (ts.isFunctionLike(node)) return;
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && binding && symbolOf(node.expression) === binding) key(`string:${node.name.text}`);
        ts.forEachChild(node, visit);
      };
      const body = isClass ? constructor?.body : (owner as ts.FunctionLikeDeclaration).body;
      if (body) visit(body);
    }
    const found = keys; dependencyCache.set(registration, found); return found;
  };
  const consumed = new Map<Container, Map<Registration, number>>();
  const executed = new Map<ts.Node, Set<string>>();
  const containerIds = new Map<Container, number>(), symbolIds = new Map<ts.Symbol, number>();
  const id = <T>(map: Map<T, number>, value: T) => { let found = map.get(value); if (found === undefined) { found = map.size; map.set(value, found); } return found; };
  const validResolution = (api: Api, method: string) => api === "inversify" ? /^(get|getAsync|getAll|getAllAsync)$/.test(method) : api === "tsyringe" ? /^(resolve|resolveAll)$/.test(method) : method === "resolve";
  type Execution = { owner: ts.Node; c: Container; lifetime: ProviderLifetime; bindings: Map<ts.Symbol, Container> };
  const consume = (c: Container, registration: Registration, inRequest: boolean) => {
    const pending = [{ c, r: registration, inRequest }];
    const functions: Execution[] = [];
    while (pending.length || functions.length) {
      budget.take();
      if (!pending.length) {
        const execution = functions.pop()!;
        const { owner, c, lifetime, bindings } = execution;
        const state = ({ singleton: 1, transient: 2, unknown: 4, request: 8 })[lifetime.kind];
        const bindingIds: string[] = [];
        for (const [symbol, target] of bindings) { budget.take(); bindingIds.push(`${id(symbolIds, symbol)}:${id(containerIds, target)}`); }
        const context = `${id(containerIds, c)}|${state}|${bindingIds.sort().join(",")}`;
        const states = executed.get(owner) ?? new Set<string>();
        if (states.has(context)) continue;
        states.add(context); executed.set(owner, states);
        merge(owner, lifetime);
        const targetContainer = (node: ts.Node) => { const symbol = symbolOf(node); return symbol && bindings.get(symbol) || container(node); };
        for (const call of constructionCalls(owner, budget)) {
          const local = resolve(call.expression);
          if (local && ts.isFunctionLike(local)) {
            const nextBindings = new Map<ts.Symbol, Container>();
            for (let i = 0; i < local.parameters.length; i++) {
              const argument = call.arguments[i], symbol = symbolOf(local.parameters[i].name);
              const target = argument && targetContainer(argument);
              if (symbol && target) nextBindings.set(symbol, target);
            }
            functions.push({ owner: local, c: nextBindings.values().next().value ?? c, lifetime, bindings: nextBindings });
          }
          if (!ts.isPropertyAccessExpression(call.expression) || !call.arguments[0]) continue;
          const target = targetContainer(call.expression.expression); if (!target) continue;
          const method = call.expression.name.text;
          if (validResolution(target.api, method)) for (const dependency of lookup(target, token(call.arguments[0]), /All/.test(method), target.api === "inversify" ? selectionFor(call.arguments[1]) : {})) {
            pending.push({ c: target, r: dependency, inRequest: lifetime.kind === "request" });
          }
          if (target.api === "awilix" && method === "build") {
            const resolver = awilixResolver(target, call.arguments[0]);
            const built = resolver?.owner ?? resolve(call.arguments[0]);
            if (built && (ts.isClassDeclaration(built) || ts.isClassExpression(built) || ts.isFunctionLike(built))) pending.push({ c: target, r: { container: target, token: call, owner: built, scope: "transient", mode: resolver?.mode ?? target.mode }, inRequest: lifetime.kind === "request" });
          }
        }
        continue;
      }
      const { c: currentContainer, r, inRequest: requestContext } = pending.pop()!;
      const states = consumed.get(currentContainer) ?? new Map<Registration, number>();
      const state = requestContext ? 2 : 1;
      if ((states.get(r) ?? 0) & state) continue;
      states.set(r, (states.get(r) ?? 0) | state); consumed.set(currentContainer, states);
      baseline(r);
      let root = currentContainer; while (root.parent) { budget.take(); root = root.parent; }
      const fresh = r.scope === "singleton" ? (currentContainer.api === "awilix" ? root.fresh : r.container.fresh || registrationFresh(r)) : r.scope === "container" ? currentContainer.fresh || registrationFresh(r) : true;
      if (fresh && requestContext && r.scope !== "unknown") merge(r.owner, { kind: "request" });
      const lifetime: ProviderLifetime = { kind: r.scope === "unknown" || r.unknown ? "unknown" : fresh ? requestContext ? "request" : "transient" : "singleton" };
      if (r.owner) {
        const bindings = new Map<ts.Symbol, Container>();
        // TSyringe factory callbacks and Inversify dynamic values receive the resolving container/context.
        if (ts.isFunctionLike(r.owner) && r.owner.parameters[0] && currentContainer.api !== "awilix") {
          const symbol = symbolOf(r.owner.parameters[0].name); if (symbol) bindings.set(symbol, currentContainer);
        }
        functions.push({ owner: r.owner, c: currentContainer, lifetime, bindings });
      }
      if (r.alias !== undefined) for (const target of lookup(currentContainer, r.alias)) pending.push({ c: currentContainer, r: target, inRequest: requestContext && fresh && r.scope !== "unknown" && !r.unknown });
      for (const key of dependencies(r)) for (const dependency of lookup(currentContainer, key.token, key.all, key)) pending.push({ c: currentContainer, r: dependency, inRequest: requestContext && fresh && r.scope !== "unknown" && !r.unknown });
    }
  };
  for (const call of calls) {
    if (!ts.isPropertyAccessExpression(call.expression) || !call.arguments[0]) continue;
    const c = container(call.expression.expression); if (!c) continue;
    const method = call.expression.name.text;
    const valid = validResolution(c.api, method);
    if (valid) resolutions.push({ container: c, token: token(call.arguments[0]), site: call, all: /All/.test(method), ...selectionFor(c.api === "inversify" ? call.arguments[1] : undefined) });
    if (c.api === "awilix" && method === "build") {
      const resolver = awilixResolver(c, call.arguments[0]);
      const owner = resolver?.owner ?? resolve(call.arguments[0]);
      if (owner && (ts.isClassDeclaration(owner) || ts.isClassExpression(owner) || ts.isFunctionLike(owner))) consume(c, { container: c, token: owner, owner, scope: "transient", mode: resolver?.mode ?? modeOf(prop(call.arguments[1], "injectionMode"), c.mode) }, request(call));
    }
  }
  for (const access of cradleResolutions) {
    if (!ts.isPropertyAccessExpression(access.expression)) continue;
    const c = container(access.expression.expression);
    if (c?.api === "awilix") resolutions.push({ container: c, token: `string:${access.name.text}`, site: access, all: false });
  }
  for (const resolution of resolutions) for (const registration of lookup(resolution.container, resolution.token, resolution.all, resolution)) consume(resolution.container, registration, request(resolution.site));
  return result;
}
