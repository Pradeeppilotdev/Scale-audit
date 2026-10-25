import ts from "typescript";
import { importedBinding } from "./bindings.js";
import { staticArray, staticExpression as resolve, staticProperty, staticReturns, isUnknownStaticValue, staticToken as token, type StaticToken as Token } from "./staticValues.js";
import { AnalysisBudget } from "./analysisBudget.js";
import type { Workspace } from "./workspace.js";

export type Lifetime = "singleton" | "request" | "transient" | "unknown";
export interface ProviderLifetime { kind: Lifetime; requestConsumer?: boolean }
interface Provider { owner: ts.Node; module: Module; kind: Lifetime; dependencies: Token[]; requestConsumer?: boolean }
interface Module { key: ts.Node; declaration?: ts.Node; providers: Map<Token, Provider[]>; imports: Module[]; exports: Set<Token>; global: boolean }
interface ClassMetadata { kind: Lifetime; dependencies: Token[]; decorated: boolean }

/** Nest tokens are visible through their owning module's providers/imports/exports. */
export function providerLifetimes(workspace: Workspace): Map<ts.Node, ProviderLifetime> {
  const budget = new AnalysisBudget("Nest lifetime", 200_000);
  const prop = (node: ts.Node | undefined, name: string) => staticProperty(node, name, budget);
  const array = (node: ts.Node | undefined) => staticArray(node, new Set(), budget);
  const classes = new Map<ts.ClassDeclaration, ClassMetadata>();
  const modules = new Map<ts.Node, Module>();
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
        const dependencies: Token[] = [];
        for (const member of node.members) if (ts.isConstructorDeclaration(member)) for (const parameter of member.parameters) {
          let explicit = false;
          for (const decorator of decorators(parameter)) {
            const call = nestCall(decorator, "Inject"); if (!call?.arguments[0]) continue;
            explicit = true;
            if (isRequestToken(call.arguments[0])) { kind = "request"; decorated = true; }
            else dependencies.push(token(call.arguments[0]));
          }
          if (!explicit && parameter.type && ts.isTypeReferenceNode(parameter.type)) dependencies.push(token(parameter.type.typeName));
        }
        for (const member of node.members) if (ts.isPropertyDeclaration(member)) for (const decorator of decorators(member)) {
          const call = nestCall(decorator, "Inject"); if (!call?.arguments[0]) continue;
          if (isRequestToken(call.arguments[0])) { kind = "request"; decorated = true; }
          else dependencies.push(token(call.arguments[0]));
        }
        classes.set(node, { kind, dependencies, decorated });
      }
      ts.forEachChild(node, visit);
    }; visit(sf);
  }
  const newModule = (key: ts.Node, declaration?: ts.Node): Module => {
    const m: Module = { key, declaration, providers: new Map(), imports: [], exports: new Set(), global: !!declaration && decorators(declaration).some(d => nestCall(d, "Global")) };
    modules.set(key, m); return m;
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
    const dependencies = [...(metadata?.dependencies ?? [])];
    if (existing) dependencies.push(token(existing));
    for (const dependency of array(prop(value, "inject"))) {
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
    if (depth > 64) throw new Error("Nest module recursion limit exceeded");
    const object = resolve(metadata); if (!object || !ts.isObjectLiteralExpression(object)) return;
    for (const provider of array(prop(object, "providers"))) register(m, provider, alternative);
    for (const controller of array(prop(object, "controllers"))) register(m, controller, alternative);
    budget.take(m.imports.length);
    const knownImports = new Set(m.imports);
    for (const imported of array(prop(object, "imports"))) { const target = processModule(imported, depth + 1); if (target && !knownImports.has(target)) { knownImports.add(target); m.imports.push(target); } }
    for (const exported of array(prop(object, "exports"))) m.exports.add(token(prop(exported, "provide") ?? exported));
    if (prop(object, "global")?.kind === ts.SyntaxKind.TrueKeyword) m.global = true;
  };
  const processModule = (expression: ts.Node, depth = 0): Module | undefined => {
    budget.take();
    const value = resolve(expression); if (!value) return undefined;
    const existing = modules.get(value); if (existing) return existing;
    if (depth > 64) throw new Error("Nest module recursion limit exceeded");
    if (ts.isClassDeclaration(value)) {
      const metadata = decorators(value).map(d => nestCall(d, "Module")).find(Boolean);
      if (!metadata) return undefined;
      const m = newModule(value, value); metadataInto(m, metadata.arguments[0], depth); return m;
    }
    if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)) {
      const owner = resolve(value.expression.expression);
      if (!owner || !ts.isClassDeclaration(owner)) return undefined;
      const metadata = decorators(owner).map(d => nestCall(d, "Module")).find(Boolean);
      if (!metadata) return undefined;
      const m = newModule(value, owner);
      metadataInto(m, metadata.arguments[0], depth);
      const returnedMetadata = staticReturns(value);
      for (const returned of returnedMetadata) metadataInto(m, returned, depth, returnedMetadata.length > 1);
      return m;
    }
    if (ts.isObjectLiteralExpression(value)) {
      const m = newModule(value, resolve(prop(value, "module"))); metadataInto(m, value, depth); return m;
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
  const lookup = (m: Module, key: Token): Provider[] => {
    const local = m.providers.get(key); if (local) return local;
    const result = new Set<Provider>();
    for (const imported of [...m.imports, ...globals.filter(global => global !== m)]) {
      budget.take(); for (const provider of exportedProviders(imported, key)) { budget.take(); result.add(provider); }
    }
    return [...result];
  };
  const providers: Provider[] = [];
  for (const module of modules.values()) for (const entries of module.providers.values()) for (const provider of entries) { budget.take(); providers.push(provider); }
  const edges = new Map<Provider, Set<Provider>>(), reverse = new Map<Provider, Set<Provider>>();
  for (const provider of providers) {
    const targets = new Set<Provider>();
    for (const dependency of provider.dependencies) for (const target of lookup(provider.module, dependency)) {
      budget.take(); targets.add(target);
      const consumers = reverse.get(target) ?? new Set(); consumers.add(provider); reverse.set(target, consumers);
    }
    edges.set(provider, targets);
  }
  // Request scope bubbles upward, while transient recreation propagates downward
  // only through transient consumers. Both traversals visit each edge at most once.
  const requests = providers.filter(p => p.kind === "request");
  for (let i = 0; i < requests.length; i++) for (const consumer of reverse.get(requests[i]) ?? []) {
    budget.take(); if (consumer.kind !== "request") { consumer.kind = "request"; requests.push(consumer); }
  }
  const consumers = [...requests];
  for (let i = 0; i < consumers.length; i++) for (const dependency of edges.get(consumers[i]) ?? []) {
    budget.take(); if (dependency.kind === "transient" && !dependency.requestConsumer) { dependency.requestConsumer = true; consumers.push(dependency); }
  }
  const result = new Map<ts.Node, ProviderLifetime>();
  const rank = { singleton: 0, transient: 1, unknown: 2, request: 3 };
  for (const provider of providers) {
    const old = result.get(provider.owner);
    if (!old || rank[provider.kind] > rank[old.kind] || provider.kind === "transient" && provider.requestConsumer) result.set(provider.owner, { kind: provider.kind, requestConsumer: provider.requestConsumer });
  }
  return result;
}
