import ts from "typescript";
import { importedBinding } from "./bindings.js";
import { staticArray, staticExpression as resolve, staticProperty, staticReturns, isUnknownStaticValue, staticToken as token, type StaticToken as Token } from "./staticValues.js";
import { AnalysisBudget, AnalysisLimitError, projectWorkLimit } from "./analysisBudget.js";
import type { Workspace } from "./workspace.js";

export type Lifetime = "singleton" | "request" | "transient" | "unknown";
export interface ProviderLifetime { kind: Lifetime; requestConsumer?: boolean }
interface Provider { owner: ts.Node; module: Module; kind: Lifetime; dependencies: Token[]; requestConsumer?: boolean }
interface Module { key: ts.Node; declaration?: ts.Node; providers: Map<Token, Provider[]>; imports: Module[]; exports: Set<Token>; global: boolean; depth: number; cyclic: boolean }
interface ClassMetadata { kind: Lifetime; dependencies: Token[]; decorated: boolean }

/** Nest tokens are visible through their owning module's providers/imports/exports. */
export function providerLifetimes(workspace: Workspace): Map<ts.Node, ProviderLifetime> {
  const budget = new AnalysisBudget("Nest lifetime", projectWorkLimit(workspace.units.map(unit => unit.sf)));
  const prop = (node: ts.Node | undefined, name: string) => staticProperty(node, name, budget);
  const array = (node: ts.Node | undefined) => staticArray(node, new Set(), budget);
  const classes = new Map<ts.ClassDeclaration, ClassMetadata>();
  const modules = new Map<ts.Node, Module>();
  const activeModules = new Set<Module>();
  const registered = new Set<ts.Node>();
  const decorators = (node: ts.Node) => ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
  const nestCall = (decorator: ts.Decorator, name: string) => {
    if (!ts.isCallExpression(decorator.expression)) return undefined;
    const binding = importedBinding(decorator.expression.expression);
    return binding?.module === "@nestjs/common" && binding.name === name ? decorator.expression : undefined;
  };
  const isRequestToken = (node: ts.Node) => { const binding = importedBinding(node); return binding?.module === "@nestjs/core" && binding.name === "REQUEST"; };
  const nodeScope = (node: ts.Node | undefined, fallback: Lifetime): Lifetime => {
    if (!node) return fallback;
    const value = resolve(node);
    if (value && ts.isNumericLiteral(value)) return ({ 0: "singleton", 1: "transient", 2: "request" } as Record<number, Lifetime>)[Number(value.text)] ?? "unknown";
    if (value && ts.isPropertyAccessExpression(value)) {
      const binding = importedBinding(value.expression);
      if (binding?.module === "@nestjs/common" && binding.name === "Scope") return value.name.text === "DEFAULT" ? "singleton" : value.name.text === "REQUEST" ? "request" : value.name.text === "TRANSIENT" ? "transient" : "unknown";
    }
    return "unknown";
  };
  interface OwnMembers { ownConstructor?: ts.ConstructorDeclaration; properties: Map<string, ts.CallExpression> }
  const memberFacts = new Map<ts.ClassDeclaration, OwnMembers>();
  const ownMembers = (declaration: ts.ClassDeclaration): OwnMembers => {
    budget.take();
    const cached = memberFacts.get(declaration); if (cached) return cached;
    const facts: OwnMembers = { properties: new Map() };
    for (const member of declaration.members) {
      budget.take();
      if (ts.isConstructorDeclaration(member) && (!facts.ownConstructor || !facts.ownConstructor.body && member.body)) facts.ownConstructor = member;
      if (!ts.isPropertyDeclaration(member)) continue;
      for (const decorator of decorators(member)) {
        budget.take(); const call = nestCall(decorator, "Inject");
        if (call?.arguments[0]) facts.properties.set(member.name.getText(), call);
      }
    }
    memberFacts.set(declaration, facts); return facts;
  };
  interface Injections { dependencies: Token[]; request: boolean }
  const constructorFacts = new Map<ts.ConstructorDeclaration, Injections>();
  const constructorDependencies = (constructor: ts.ConstructorDeclaration) => {
    budget.take();
    const cached = constructorFacts.get(constructor); if (cached) return cached;
    const facts = { dependencies: [] as Token[], request: false };
    for (const parameter of constructor.parameters) {
      budget.take(); let explicit = false;
      for (const decorator of decorators(parameter)) {
        budget.take(); const call = nestCall(decorator, "Inject"); if (!call?.arguments[0]) continue;
        explicit = true;
        if (isRequestToken(call.arguments[0])) facts.request = true;
        else facts.dependencies.push(token(call.arguments[0]));
      }
      if (!explicit && parameter.type && ts.isTypeReferenceNode(parameter.type)) facts.dependencies.push(token(parameter.type.typeName));
    }
    constructorFacts.set(constructor, facts); return facts;
  };
  const classInjections = new Map<ts.ClassDeclaration, Injections>();
  const injectionsOf = (declaration: ts.ClassDeclaration): Injections => {
    const visited = new Set<ts.ClassDeclaration>();
    let firstOwner: ts.ClassDeclaration | undefined, constructor: ts.ConstructorDeclaration | undefined;
    const lineage: OwnMembers[] = [];
    let current: ts.Node | undefined = declaration;
    while (current && ts.isClassDeclaration(current) && !visited.has(current)) {
      budget.take(); visited.add(current);
      // A subclass with no constructor or injected properties inherits the
      // entire resolved list, including overridden property tokens.
      const inherited = !firstOwner && classInjections.get(current);
      if (inherited) { classInjections.set(declaration, inherited); return inherited; }
      const members = ownMembers(current);
      if (members.ownConstructor || members.properties.size) firstOwner ??= current;
      constructor ??= members.ownConstructor;
      if (members.properties.size) lineage.push(members);
      const base: ts.Expression | undefined = current.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
      current = base ? resolve(base) : undefined;
    }
    // Only the nearest constructor supplies parameters; property injection
    // merges independently from base to derived.
    let facts: Injections = constructor ? constructorDependencies(constructor) : { dependencies: [], request: false };
    if (lineage.length) {
      const properties = new Map<string, ts.CallExpression>();
      for (const members of lineage.reverse()) for (const [name, call] of members.properties) {
        budget.take(); properties.set(name, call);
      }
      budget.take(facts.dependencies.length);
      facts = { dependencies: [...facts.dependencies], request: facts.request };
      for (const call of properties.values()) {
        budget.take();
        if (isRequestToken(call.arguments[0])) facts.request = true;
        else facts.dependencies.push(token(call.arguments[0]));
      }
    }
    if (firstOwner) classInjections.set(firstOwner, facts);
    classInjections.set(declaration, facts); return facts;
  };
  for (const { sf } of workspace.units) {
    const visit = (node: ts.Node) => {
      if (ts.isClassDeclaration(node)) {
        let kind: Lifetime = "singleton"; let decorated = false;
        for (const decorator of decorators(node)) {
          const injectable = nestCall(decorator, "Injectable");
          const call = injectable ?? nestCall(decorator, "Controller");
          if (!call) continue;
          decorated = true;
          const options = resolve(call.arguments[0]);
          kind = options && ts.isObjectLiteralExpression(options) ? nodeScope(prop(options, "scope"), "singleton")
            : !options || (!injectable && ts.isStringLiteralLike(options)) ? "singleton" : "unknown";
        }
        const facts = injectionsOf(node);
        if (facts.request) { kind = "request"; decorated = true; }
        classes.set(node, { kind, dependencies: facts.dependencies, decorated });
      }
      ts.forEachChild(node, visit);
    }; visit(sf);
  }
  const newModule = (key: ts.Node, declaration?: ts.Node): Module => {
    const m: Module = { key, declaration, providers: new Map(), imports: [], exports: new Set(), global: !!declaration && decorators(declaration).some(d => nestCall(d, "Global")), depth: 0, cyclic: false };
    modules.set(key, m); return m;
  };
  const validateModuleDepth = (m: Module, depth: number, path: Set<Module>): void => {
    budget.take();
    if (path.has(m)) return; // A genuine cycle is not an ever-deeper import path.
    if (depth > 64 || !m.cyclic && depth + m.depth > 64) throw new AnalysisLimitError("Nest module recursion limit exceeded");
    if (!m.cyclic) return;
    // A cyclic suffix depends on the active path. Do not reuse a scalar depth
    // calculated while one of its ancestors was still being constructed.
    path.add(m);
    for (const imported of m.imports) validateModuleDepth(imported, depth + 1, path);
    path.delete(m);
  };
  const buildModule = (key: ts.Node, declaration: ts.Node | undefined, build: (m: Module) => void): Module => {
    const m = newModule(key, declaration); activeModules.add(m);
    try { build(m); return m; } finally { activeModules.delete(m); }
  };
  const register = (m: Module, provider: ts.Node, alternative = false) => {
    const store = (key: Token, entry: Provider) => { const previous = alternative ? m.providers.get(key) ?? [] : []; budget.take(previous.length); m.providers.set(key, [...previous, entry]); };
    budget.take();
    const value = resolve(provider); if (!value) return;
    if (ts.isClassDeclaration(value)) {
      const metadata = classes.get(value);
      registered.add(value);
      store(value, { owner: value, module: m, kind: metadata?.kind ?? "singleton", dependencies: metadata?.dependencies ?? [] }); return;
    }
    if (!ts.isObjectLiteralExpression(value)) return;
    const factory = resolve(prop(value, "useFactory"));
    const implementation = resolve(prop(value, "useClass"));
    const existing = prop(value, "useExisting");
    const owner = factory && ts.isFunctionLike(factory) ? factory : implementation && ts.isClassDeclaration(implementation) ? implementation : value;
    const metadata = ts.isClassDeclaration(owner) ? classes.get(owner) : undefined;
    let kind = nodeScope(prop(value, "scope"), metadata?.kind ?? "singleton");
    const injected = array(prop(value, "inject"));
    let dependencies = metadata?.dependencies ?? [];
    if (existing || injected.length) { budget.take(dependencies.length); dependencies = [...dependencies]; }
    if (existing) dependencies.push(token(existing));
    for (const dependency of injected) {
      budget.take();
      if (isUnknownStaticValue(dependency)) { if (kind !== "request") kind = "unknown"; continue; }
      const options = resolve(dependency);
      const target = options && ts.isObjectLiteralExpression(options) ? prop(options, "token") : dependency;
      if (!target) continue;
      if (isRequestToken(target)) kind = "request"; else dependencies.push(token(target));
    }
    const provided = prop(value, "provide");
    registered.add(owner);
    if (provided) store(token(provided), { owner, module: m, kind, dependencies });
  };
  const metadataInto = (m: Module, metadata: ts.Node | undefined, depth: number, alternative = false) => {
    budget.take();
    if (depth > 64) throw new AnalysisLimitError("Nest module recursion limit exceeded");
    const object = resolve(metadata); if (!object || !ts.isObjectLiteralExpression(object)) return;
    for (const provider of array(prop(object, "providers"))) register(m, provider, alternative);
    for (const controller of array(prop(object, "controllers"))) register(m, controller, alternative);
    budget.take(m.imports.length);
    const knownImports = new Set(m.imports);
    for (const imported of array(prop(object, "imports"))) {
      const target = processModule(imported, depth + 1);
      if (!target) continue;
      if (activeModules.has(target)) { target.cyclic = true; m.cyclic = true; }
      else if (target.cyclic) m.cyclic = true;
      else m.depth = Math.max(m.depth, target.depth + 1);
      if (!knownImports.has(target)) { knownImports.add(target); m.imports.push(target); }
    }
    for (const exported of array(prop(object, "exports"))) m.exports.add(token(prop(exported, "provide") ?? exported));
    if (prop(object, "global")?.kind === ts.SyntaxKind.TrueKeyword) m.global = true;
  };
  const processModule = (expression: ts.Node, depth = 0): Module | undefined => {
    budget.take();
    const value = resolve(expression); if (!value) return undefined;
    const existing = modules.get(value);
    if (existing) {
      budget.take(activeModules.size);
      validateModuleDepth(existing, depth, new Set(activeModules)); return existing;
    }
    if (depth > 64) throw new AnalysisLimitError("Nest module recursion limit exceeded");
    if (ts.isClassDeclaration(value)) {
      const metadata = decorators(value).map(d => nestCall(d, "Module")).find(Boolean);
      if (!metadata) return undefined;
      return buildModule(value, value, m => metadataInto(m, metadata.arguments[0], depth));
    }
    if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)) {
      const owner = resolve(value.expression.expression);
      if (!owner || !ts.isClassDeclaration(owner)) return undefined;
      const metadata = decorators(owner).map(d => nestCall(d, "Module")).find(Boolean);
      if (!metadata) return undefined;
      return buildModule(value, owner, m => {
        metadataInto(m, metadata.arguments[0], depth);
        const returnedMetadata = staticReturns(value, budget);
        for (const returned of returnedMetadata) metadataInto(m, returned, depth, returnedMetadata.length > 1);
      });
    }
    if (ts.isObjectLiteralExpression(value)) {
      return buildModule(value, resolve(prop(value, "module")), m => metadataInto(m, value, depth));
    }
    return undefined;
  };
  for (const declaration of classes.keys()) processModule(declaration);
  // Standalone decorated sources have no module boundary to resolve. Keep only
  // these class identities together; never mix string tokens from unrelated modules.
  const orphan = newModule(ts.factory.createIdentifier("unregisteredNestClasses"));
  for (const [declaration, metadata] of classes) if (metadata.decorated && !registered.has(declaration)) orphan.providers.set(declaration, [{ owner: declaration, module: orphan, kind: metadata.kind, dependencies: metadata.dependencies }]);
  const importedModules = new Set<Module>();
  for (const module of modules.values()) for (const imported of module.imports) { budget.take(); importedModules.add(imported); }
  const globals = [...modules.values()].filter(m => m.global && importedModules.has(m));
  const exportCache = new Map<Module, Map<Token, Provider[]>>();
  const exportedProviders = (m: Module, key: Token): Provider[] => {
    const cached = exportCache.get(m)?.get(key); if (cached) return cached;
    const pending = [m], seen = new Set<Module>(), found = new Set<Provider>();
    while (pending.length) {
      budget.take();
      const current = pending.pop()!; if (seen.has(current)) continue; seen.add(current);
      if (current.exports.has(key)) {
        const local = current.providers.get(key);
        if (local) { for (const provider of local) { budget.take(); found.add(provider); } continue; }
        for (const imported of current.imports) { budget.take(); pending.push(imported); }
      } else for (const imported of current.imports) {
        budget.take();
        if (current.exports.has(imported.key) || !!imported.declaration && current.exports.has(imported.declaration)) pending.push(imported);
      }
    }
    const result = [...found];
    const byToken = exportCache.get(m) ?? new Map(); byToken.set(key, result); exportCache.set(m, byToken); return result;
  };
  const lookupCache = new Map<Module, Map<Token, Provider[]>>();
  const lookup = (m: Module, key: Token): Provider[] => {
    budget.take(); // Missing and repeated tokens are still lookups.
    const local = m.providers.get(key); if (local) return local;
    const byToken = lookupCache.get(m) ?? new Map<Token, Provider[]>();
    const cached = byToken.get(key); if (cached) return cached;
    const result = new Set<Provider>();
    const collect = (imported: Module) => {
      budget.take(); for (const provider of exportedProviders(imported, key)) { budget.take(); result.add(provider); }
    };
    for (const imported of m.imports) collect(imported);
    for (const global of globals) { budget.take(); if (global !== m) collect(global); }
    const visible = [...result]; byToken.set(key, visible); lookupCache.set(m, byToken); return visible;
  };
  const providers: Provider[] = [];
  for (const module of modules.values()) for (const entries of module.providers.values()) for (const provider of entries) { budget.take(); providers.push(provider); }
  // Inherited constructor metadata can be shared by many providers. Resolve
  // each dependency list once within its owning module, including empty results.
  interface DependencyGroup { consumers: Provider[]; targets: Set<Provider> }
  const groups = new Map<Module, Map<Token[], DependencyGroup>>();
  const groupOf = new Map<Provider, DependencyGroup>();
  const reverse = new Map<Provider, DependencyGroup[]>();
  for (const provider of providers) {
    budget.take();
    const byDependencies = groups.get(provider.module) ?? new Map<Token[], DependencyGroup>();
    let group = byDependencies.get(provider.dependencies);
    if (!group) {
      const targets = new Set<Provider>();
      for (const dependency of provider.dependencies) for (const target of lookup(provider.module, dependency)) {
        budget.take(); targets.add(target);
      }
      group = { consumers: [], targets };
      for (const target of targets) {
        budget.take();
        const consumingGroups = reverse.get(target) ?? []; consumingGroups.push(group); reverse.set(target, consumingGroups);
      }
      byDependencies.set(provider.dependencies, group); groups.set(provider.module, byDependencies);
    }
    group.consumers.push(provider); groupOf.set(provider, group);
  }
  // A request dependency affects all consumers in its group. In the reverse
  // direction, one request-scoped consumer reaches all the group's targets.
  const reached = new Set<DependencyGroup>();
  const requests = providers.filter(p => p.kind === "request");
  for (let i = 0; i < requests.length; i++) for (const group of reverse.get(requests[i]) ?? []) {
    budget.take(); if (reached.has(group)) continue; reached.add(group);
    for (const consumer of group.consumers) {
      budget.take(); if (consumer.kind !== "request") { consumer.kind = "request"; requests.push(consumer); }
    }
  }
  reached.clear();
  const consumers = [...requests];
  for (let i = 0; i < consumers.length; i++) {
    budget.take();
    const group = groupOf.get(consumers[i])!;
    if (reached.has(group)) continue; reached.add(group);
    for (const dependency of group.targets) {
      budget.take(); if (dependency.kind === "transient" && !dependency.requestConsumer) { dependency.requestConsumer = true; consumers.push(dependency); }
    }
  }
  const result = new Map<ts.Node, ProviderLifetime>();
  const rank = { singleton: 0, transient: 1, unknown: 2, request: 3 };
  for (const provider of providers) {
    const old = result.get(provider.owner);
    if (!old || rank[provider.kind] > rank[old.kind] || provider.kind === "transient" && provider.requestConsumer) result.set(provider.owner, { kind: provider.kind, requestConsumer: provider.requestConsumer });
  }
  return result;
}
