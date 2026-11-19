import ts from "typescript";
import { symbolOf } from "./bindings.js";
import { AnalysisBudget, projectWorkLimit } from "./analysisBudget.js";
import type { SourceProject } from "./project.js";

type Loader = "here" | "unknown";
/** A createRequire result resolves relative to its argument, which can differ
 * from this file. Unknown bases must keep automatic edits manual. */
export function runtimeLoaderLookup(budget: AnalysisBudget) {
  const cache = new WeakMap<ts.Declaration, Loader | null>();
  const factoryCache = new WeakMap<ts.Declaration, boolean>();
  const declarationOf = (node: ts.Identifier) => {
    const symbol = symbolOf(node); return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  };
  function member(node: ts.Node, name: string): boolean {
    return ts.isPropertyAccessExpression(node) && node.name.text === name
      || ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === name;
  }
  function factory(node: ts.Expression): boolean {
    const seen = new Set<ts.Declaration>();
    let result = false;
    while (ts.isIdentifier(node)) {
      budget.take();
      if (node.text === "createRequire") { result = true; break; }
      const declaration = declarationOf(node);
      if (declaration && factoryCache.has(declaration)) { result = factoryCache.get(declaration)!; break; }
      if (declaration && (ts.isImportSpecifier(declaration) || ts.isBindingElement(declaration))) {
        const name = declaration.propertyName ?? declaration.name;
        result = ts.isIdentifier(name) && name.text === "createRequire"; break;
      }
      if (!declaration || seen.has(declaration) || !ts.isVariableDeclaration(declaration) || !declaration.initializer) break;
      seen.add(declaration); node = declaration.initializer;
    }
    result ||= member(node, "createRequire");
    for (const declaration of seen) { budget.take(); factoryCache.set(declaration, result); }
    return result;
  }
  return (original: ts.Expression): Loader | undefined => {
    let value: ts.Expression = original, result: Loader | undefined;
    const visited = new Set<ts.Declaration>();
    while (true) {
      budget.take();
      if (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isNonNullExpression(value)
        || ts.isTypeAssertionExpression(value) || ts.isSatisfiesExpression(value)) { value = value.expression; continue; }
      if (ts.isCallExpression(value)) {
        if (factory(value.expression)) {
          const base = value.arguments[0];
          result = base && (ts.isIdentifier(base) && base.text === "__filename" && !declarationOf(base)
            || ts.isPropertyAccessExpression(base) && base.name.text === "url" && ts.isMetaProperty(base.expression)
              && base.expression.keywordToken === ts.SyntaxKind.ImportKeyword) ? "here" : "unknown";
        } else if (ts.isPropertyAccessExpression(value.expression) && value.expression.name.text === "bind") {
          // A borrowed/bound module.require may use a different module base.
          if (member(value.expression.expression, "require") || ts.isIdentifier(value.expression.expression)
            && value.expression.expression.text === "require") result = "unknown";
        }
        break;
      }
      if ((ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) && member(value, "require")) {
        result = ts.isIdentifier(value.expression) && value.expression.text === "module" ? "here" : "unknown";
        break;
      }
      if (!ts.isIdentifier(value)) break;
      const declaration = declarationOf(value);
      if (value.text === "require" && (!declaration || !ts.isVariableDeclaration(declaration)
        || !declaration.initializer || !ts.isCallExpression(declaration.initializer))) { result = "here"; break; }
      if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) break;
      if (cache.has(declaration)) { result = cache.get(declaration) ?? undefined; break; }
      if (visited.has(declaration)) break;
      visited.add(declaration);
      value = declaration.initializer;
    }
    if (!result && ts.isIdentifier(original) && original.text === "require") result = "unknown";
    for (const declaration of visited) { budget.take(); cache.set(declaration, result ?? null); }
    return result;
  };
}

/** Runtime links group modules that can share a mutable import. Only static
 * ESM edges establish that a dependency finishes before its importer runs. */
export class ModuleEffects {
  readonly budget: AnalysisBudget;
  inputsKnown = true;
  private readonly neighbors = new Map<ts.SourceFile, Set<ts.SourceFile>>();
  private readonly dependencies = new Map<ts.SourceFile, Set<ts.SourceFile>>();
  private readonly importers = new Map<ts.SourceFile, Set<ts.SourceFile>>();
  private readonly groups = new Map<ts.SourceFile, readonly ts.SourceFile[]>();
  private readonly compilerOnlyImports = new Set<ts.SourceFile>();
  private readonly observations = new Set<ts.SourceFile>();
  private readonly orders = new Map<ts.SourceFile, { earlier: Set<ts.SourceFile>; later: Set<ts.SourceFile> }>();

  constructor(project: SourceProject, constantSpecifier: (value: ts.Expression) => string | undefined) {
    this.budget = new AnalysisBudget("Module mutation provenance", projectWorkLimit(project.sources.values()));
    const loader = runtimeLoaderLookup(this.budget);
    const add = (map: Map<ts.SourceFile, Set<ts.SourceFile>>, from: ts.SourceFile, to: ts.SourceFile) => {
      const set = map.get(from) ?? new Set(); set.add(to); map.set(from, set);
    };
    for (const sf of project.sources.values()) {
      const link = (specifier: string, eager: boolean) => {
        const rel = project.resolve(sf.fileName, specifier), target = rel && project.sources.get(rel);
        if (!target) {
          if (/^(?:[.#/]|file:)/.test(specifier) || project.isPackageSelfReference(sf.fileName, specifier)) this.inputsKnown = false;
          return;
        }
        if (project.compilerOnlyResolution(sf.fileName, specifier)) this.compilerOnlyImports.add(sf);
        if (rel && project.runtimeTargetAmbiguous(specifier, rel)) this.inputsKnown = false;
        if (target === sf) return;
        add(this.neighbors, sf, target); add(this.neighbors, target, sf);
        if (eager) {
          this.budget.take();
          add(this.dependencies, sf, target);
          add(this.importers, target, sf);
        }
      };
      const pending: ts.Node[] = [sf];
      while (pending.length) {
        this.budget.take(); const node = pending.pop()!;
        if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
          const clause = node.importClause, names = clause?.namedBindings;
          if (!clause?.isTypeOnly && (clause?.name || !names || !ts.isNamedImports(names) || !names.elements.length
            || names.elements.some(entry => { this.budget.take(); return !entry.isTypeOnly; }))) link(node.moduleSpecifier.text, true);
        } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
          const names = node.exportClause;
          if (!names || !ts.isNamedExports(names) || !names.elements.length
            || names.elements.some(entry => { this.budget.take(); return !entry.isTypeOnly; })) link(node.moduleSpecifier.text, true);
        } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
          const specifier = node.moduleReference.expression;
          if (ts.isStringLiteralLike(specifier)) link(specifier.text, false);
          else this.inputsKnown = false;
        } else if (ts.isCallExpression(node) && node.arguments[0]) {
          // Conditional or deferred loads can affect identity without proving
          // initialization order. A lexical require cannot supply such proof.
          const kind = node.expression.kind === ts.SyntaxKind.ImportKeyword ? "here" : loader(node.expression);
          if (kind) {
            const specifier = constantSpecifier(node.arguments[0]);
            if (specifier === undefined || kind === "unknown") this.inputsKnown = false;
            else link(specifier, false);
          }
        }
        ts.forEachChild(node, child => { pending.push(child); });
      }
    }
  }

  private reachable(sf: ts.SourceFile, edges: Map<ts.SourceFile, Set<ts.SourceFile>>): Set<ts.SourceFile> {
    const seen = new Set([sf]), pending = [sf];
    while (pending.length) {
      this.budget.take();
      for (const other of edges.get(pending.pop()!) ?? []) {
        this.budget.take(); if (!seen.has(other)) { seen.add(other); pending.push(other); }
      }
    }
    return seen;
  }

  group(sf: ts.SourceFile): readonly ts.SourceFile[] {
    const cached = this.groups.get(sf); if (cached) return cached;
    const group = [...this.reachable(sf, this.neighbors)];
    const ambiguous = this.compilerOnlyImports.size > 0 && group.some(member => { this.budget.take(); return this.compilerOnlyImports.has(member); });
    for (const member of group) {
      this.budget.take();
      this.groups.set(member, group);
      if (ambiguous) this.compilerOnlyImports.add(member);
    }
    return group;
  }

  inputsKnownFor(sf: ts.SourceFile): boolean {
    if (this.inputsKnown && this.compilerOnlyImports.size) this.group(sf);
    return this.inputsKnown && !this.compilerOnlyImports.has(sf);
  }

  writerOrder(writer: ts.SourceFile, observer: ts.SourceFile): "before" | "after" | "unknown" {
    this.budget.take();
    // Many routes can observe one startup write, or one route can observe many
    // writers. Both orders follow from the same two traversals at either end.
    const reuseObserver = this.orders.has(observer) || (this.observations.has(observer) && !this.orders.has(writer));
    this.observations.add(observer);
    const anchor = reuseObserver ? observer : writer;
    let paths = this.orders.get(anchor);
    if (!paths) {
      paths = { earlier: this.reachable(anchor, this.dependencies), later: this.reachable(anchor, this.importers) };
      this.orders.set(anchor, paths);
    }
    const before = reuseObserver ? paths.earlier.has(writer) : paths.later.has(observer);
    const after = reuseObserver ? paths.later.has(writer) : paths.earlier.has(observer);
    if (before === after) return "unknown"; // Unordered modules and import cycles.
    return before ? "before" : "after";
  }
}
