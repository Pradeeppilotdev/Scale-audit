import ts from "typescript";
import path from "node:path";
import { SourceProject } from "./project.js";
import { AnalysisBudget, AnalysisLimitError, projectWorkLimit } from "./analysisBudget.js";
import { conditionTruth } from "./conditionTruth.js";
import { ModuleEffects } from "./moduleEffects.js";

const projects = new WeakMap<ts.SourceFile, SourceProject>();
export async function initializeBindings(root: string, sources: { rel: string; sf: ts.SourceFile }[], prepared?: SourceProject): Promise<void> {
  const project = prepared ?? await SourceProject.create(root, sources);
  project.registerSources(sources);
  for (const unit of sources) {
    projects.set(unit.sf, project);
  }
}
export function projectFor(sf: ts.SourceFile): SourceProject | undefined { return projects.get(sf); }
interface Binding { declaration?: ts.Declaration; imported?: { module: string; name: string } }

/** Cycles are unknown identities; exhausted traversal is incomplete analysis. */
const MAX_BINDING_DEPTH = 128;
function bindingStep(node: ts.Node, seen: Set<ts.Node>): Set<ts.Node> | undefined {
  if (seen.has(node)) return undefined;
  if (seen.size > MAX_BINDING_DEPTH) throw new AnalysisLimitError("Binding resolution depth limit exceeded");
  return new Set(seen).add(node);
}


const checkers = new WeakMap<ts.SourceFile, ts.TypeChecker>();
/** Bind one source without loading or executing dependencies.
 * noLib is an identity invariant: native globals have no declaration, while
 * locally shadowed globals do. HTTP, timer and Promise checks rely on this
 * distinction; adding ambient libraries requires changing those checks too.
 */
export function checkerFor(sf: ts.SourceFile): ts.TypeChecker {
  let checker = checkers.get(sf);
  if (!checker) {
    const host = ts.createCompilerHost({ noLib: true, noResolve: true, allowJs: true });
    host.getSourceFile = name => name === sf.fileName ? sf : undefined;
    checker = ts.createProgram([sf.fileName], { noLib: true, noResolve: true, allowJs: true }, host).getTypeChecker();
    checkers.set(sf, checker);
  }
  return checker;
}

export function symbolOf(node: ts.Node): ts.Symbol | undefined {
  const sf = node.getSourceFile();
  if (!sf) return undefined;
  const checker = checkerFor(sf);
  if (ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) {
    return checker.getShorthandAssignmentValueSymbol(node.parent) ?? checker.getSymbolAtLocation(node);
  }
  return checker.getSymbolAtLocation(node);
}

/** A local function/parameter named require is not Node's module loader. */
const resolvingCommonJsLoaders = [new WeakSet<ts.VariableDeclaration>(), new WeakSet<ts.VariableDeclaration>()];
export function isCommonJsRequire(node: ts.Node, members = true): boolean {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return memberName(node) === "require" && ts.isIdentifier(node.expression) && node.expression.text === "module"
      && isCommonJsExportTarget(node.expression);
  }
  if (!ts.isIdentifier(node)) return false;
  const symbol = symbolOf(node);
  if (!symbol?.declarations?.length) return node.text === "require";
  const declaration = symbol.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isVariableDeclarationList(declaration.parent)
    || !(declaration.parent.flags & ts.NodeFlags.Const) || !declaration.initializer
    || !ts.isCallExpression(declaration.initializer)) return false;
  const factory = declaration.initializer.expression;
  if (node.text !== "require" && !isCreateRequireName(factory)) return false;
  const base = declaration.initializer.arguments[0];
  if (!base || !(ts.isIdentifier(base) && base.text === "__filename" && !symbolOf(base)?.declarations?.length
    || ts.isPropertyAccessExpression(base) && base.name.text === "url" && ts.isMetaProperty(base.expression)
      && base.expression.keywordToken === ts.SyntaxKind.ImportKeyword)) return false;
  // Preserve the explicit native createRequire form without following a
  // self-referential loader declaration through binding resolution.
  if (ts.isIdentifier(factory) && symbolOf(factory) === symbol) return false;
  const resolving = resolvingCommonJsLoaders[members ? 1 : 0];
  if (resolving.has(declaration)) return false;
  resolving.add(declaration);
  try {
    const binding = currentImportedBinding(factory, factory, new Set(), members);
    return !!binding && /^(?:node:)?module$/.test(binding.module) && binding.name === "createRequire";
  } finally {
    resolving.delete(declaration);
  }
}

function isCreateRequireName(factory: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(factory) || ts.isElementAccessExpression(factory)) return memberName(factory) === "createRequire";
  if (!ts.isIdentifier(factory)) return false;
  if (factory.text === "createRequire") return true;
  const declaration = symbolOf(factory)?.declarations?.[0];
  return !!declaration && (ts.isImportSpecifier(declaration) || ts.isBindingElement(declaration))
    && (declaration.propertyName ?? declaration.name).getText() === "createRequire";
}

export function isCommonJsExportTarget(node: ts.Expression): boolean {
  let root = node;
  while (ts.isPropertyAccessExpression(root)) root = root.expression;
  if (!ts.isIdentifier(root) || root.text !== "exports" && root.text !== "module") return false;
  // JavaScript's CommonJS binder attaches an export-assignment symbol even
  // when a lexical module/exports variable exists. Resolve the name in scope.
  const symbol = checkerFor(root.getSourceFile()).resolveName(root.text, root, ts.SymbolFlags.Value | ts.SymbolFlags.Alias, false);
  return !symbol?.declarations?.length || !!(symbol.flags & ts.SymbolFlags.ModuleExports)
    || symbol.declarations.every(declaration => declaration === root.getSourceFile());
}

function moduleBinding(sf: ts.SourceFile, module: string, name: string, seen: Set<ts.Node>): Binding {
  const project = projectFor(sf);
  const rel = project?.resolve(sf.fileName, module);
  if (!rel) return { imported: { module, name } };
  const target = project!.sources.get(rel)!;
  return exportedBinding(target, name, seen);
}
function exportedBinding(sf: ts.SourceFile, name: string, seen: Set<ts.Node>): Binding {
  const next = bindingStep(sf, seen);
  if (!next) return {};
  const budget = bindingWriteIndex(sf).budget, exports = currentModuleExports(sf);
  budget.take();
  const commonJs = !exports.commonJs.uncertain ? exports.commonJs : undefined;
  const explicit = exports.named.get(name);
  const entry = explicit ?? (name === "default" && commonJs?.value
    ? { kind: "snapshot" as const, expression: commonJs.value }
    : name !== "default" ? commonJs?.named.get(name) : undefined);
  if (entry) {
    if (entry.kind === "namespace") return { imported: { module: entry.module, name: "*" }, declaration: entry.declaration };
    if (entry.kind === "forward") return moduleBinding(sf, entry.module, entry.name, next);
    if (entry.kind === "declaration") {
      const declaration = entry.declaration;
      return declaration && (ts.isClassDeclaration(declaration) || ts.isFunctionDeclaration(declaration))
        ? { declaration } : declarationBinding(declaration, next);
    }
    if (explicit && ts.isExportAssignment(entry.expression.parent) && !ts.isIdentifier(entry.expression)) {
      return { declaration: entry.expression.parent };
    }
    return bindingOf(entry.expression, next);
  }
  if (commonJs?.value && ts.isCallExpression(commonJs.value) && isCommonJsRequire(commonJs.value.expression)
    && commonJs.value.arguments[0] && ts.isStringLiteral(commonJs.value.arguments[0])) {
    return moduleBinding(sf, commonJs.value.arguments[0].text, name, next);
  }
  for (const source of exports.stars) {
    budget.take();
    const found = moduleBinding(sf, source, name, next);
    if (found.declaration || found.imported) return found;
  }
  return {};
}
function declarationBinding(declaration: ts.Declaration | undefined, seen: Set<ts.Node>): Binding {
  if (!declaration) return {};
  const next = bindingStep(declaration, seen);
  if (!next) return {};
  let parent: ts.Node | undefined = declaration;
  while (parent && !ts.isImportDeclaration(parent)) parent = parent.parent;
  if (parent && ts.isStringLiteral(parent.moduleSpecifier)) {
    const name = ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text
      : ts.isNamespaceImport(declaration) ? "*" : "default";
    if (name === "*") return { imported: { module: parent.moduleSpecifier.text, name }, declaration };
    return moduleBinding(declaration.getSourceFile(), parent.moduleSpecifier.text, name, next);
  }
  const variable = ts.isBindingElement(declaration) ? declaration.parent.parent : declaration;
  if (ts.isVariableDeclaration(variable) && variable.initializer) {
    const init = variable.initializer;
    const call = ts.isPropertyAccessExpression(init) ? init.expression : init;
    if (ts.isCallExpression(call) && isCommonJsRequire(call.expression) && call.arguments[0] && ts.isStringLiteral(call.arguments[0])) {
      const name = ts.isBindingElement(declaration) ? (declaration.propertyName ?? declaration.name).getText()
        : ts.isPropertyAccessExpression(init) ? init.name.text : "*";
      if (name !== "*") return moduleBinding(variable.getSourceFile(), call.arguments[0].text, name, next);
      const project = projectFor(variable.getSourceFile());
      const local = project?.resolve(variable.getSourceFile().fileName, call.arguments[0].text);
      if (local) {
        const direct = exportedBinding(project!.sources.get(local)!, "default", next);
        if (direct.declaration || direct.imported) return direct;
      }
      return { declaration, imported: { module: call.arguments[0].text, name } };
    }
    if (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init)) {
      const alias = bindingOf(init, next);
      if (alias.declaration || alias.imported) return alias;
    }
  }
  return { declaration };
}
const identities = new WeakMap<ts.Node, { project?: SourceProject; binding: Binding }>();
export function bindingOf(node: ts.Node, seen = new Set<ts.Node>()): Binding {
  if (seen.size) return resolveBinding(node, seen);
  const project = projectFor(node.getSourceFile());
  const cached = identities.get(node);
  if (cached && cached.project === project) return cached.binding;
  const binding = resolveBinding(node, seen);
  identities.set(node, { project, binding });
  return binding;
}
function resolveBinding(node: ts.Node, seen: Set<ts.Node>): Binding {
  const next = bindingStep(node, seen);
  if (!next) return {};
  if (ts.isPropertyAccessExpression(node)) {
    if (ts.isCallExpression(node.expression) && isCommonJsRequire(node.expression.expression)
      && node.expression.arguments[0] && ts.isStringLiteral(node.expression.arguments[0])) {
      return moduleBinding(node.getSourceFile(), node.expression.arguments[0].text, node.name.text, next);
    }
    const receiver = bindingOf(node.expression, next);
    if (receiver.imported?.name === "*") {
      return moduleBinding(receiver.declaration?.getSourceFile() ?? node.getSourceFile(), receiver.imported.module, node.name.text, next);
    }
  }
  const symbol = symbolOf(node);
  return declarationBinding(symbol?.valueDeclaration ?? symbol?.declarations?.[0], next);
}
export function definitionOf(node: ts.Node): ts.Declaration | undefined { return bindingOf(node).declaration; }
export function importedBinding(node: ts.Node): { module: string; name: string } | null { return bindingOf(node).imported ?? null; }

type ImportedIdentity = { module: string; name: string };
const currentImports = [0, 1].map(() => new WeakMap<ts.Node, WeakMap<ts.Node, { project?: SourceProject; imported: ImportedIdentity | null }>>());
const currentImportSources = new WeakMap<{ module: string; name: string }, ts.SourceFile>();
const axiosInstances = new WeakMap<ImportedIdentity, ts.CallExpression>();
const axiosLoads = new WeakMap<ImportedIdentity, "require" | "global">();
function axiosIdentity(name: string, origin: ts.SourceFile, instance?: ts.CallExpression,
  load?: "require" | "global"): ImportedIdentity {
  const imported = { module: "axios", name };
  currentImportSources.set(imported, origin);
  if (instance) axiosInstances.set(imported, instance);
  if (load) axiosLoads.set(imported, load);
  return imported;
}
function axiosLookup(imported: ImportedIdentity, fallback: ts.SourceFile): string {
  const load = axiosLoads.get(imported);
  return load === "global" ? "global" : (load ?? "import") + "\0" + path.posix.dirname((currentImportSources.get(imported) ?? fallback).fileName);
}

type CurrentExport = { kind: "declaration"; declaration?: ts.Declaration }
  | { kind: "snapshot"; expression: ts.Expression }
  | { kind: "namespace"; module: string; declaration: ts.NamespaceExport }
  | { kind: "forward"; module: string; name: string };
interface CurrentModuleExports {
  named: Map<string, CurrentExport>;
  commonJs: { named: Map<string, CurrentExport>; value?: ts.Expression; uncertain: boolean };
  stars: string[];
}
const currentExportIndexes = new WeakMap<ts.SourceFile, { project?: SourceProject; exports: CurrentModuleExports }>();

/** Cache export syntax, not resolved provenance: every observation still walks
 * its alias/module chain through the unchanged binding depth checks. */
function currentModuleExports(sf: ts.SourceFile): CurrentModuleExports {
  const project = projectFor(sf), cached = currentExportIndexes.get(sf);
  if (cached && cached.project === project) return cached.exports;
  const exports: CurrentModuleExports = { named: new Map(), commonJs: { named: new Map(), uncertain: false }, stars: [] };
  const budget = bindingWriteIndex(sf).budget;
  const add = (name: string, value: CurrentExport): void => {
    if (!exports.named.has(name)) exports.named.set(name, value);
  };
  const directWrites = new Set<ts.Node>();
  let exportsLinked = true;
  for (const statement of sf.statements) {
    budget.take();
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      const source = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
      if (!statement.exportClause) { if (source) exports.stars.push(source); continue; }
      if (source && ts.isNamespaceExport(statement.exportClause)) {
        add(statement.exportClause.name.text, { kind: "namespace", module: source, declaration: statement.exportClause });
      }
      if (ts.isNamedExports(statement.exportClause)) for (const entry of statement.exportClause.elements) {
        budget.take();
        if (entry.isTypeOnly) continue;
        if (source) add(entry.name.text, { kind: "forward", module: source, name: (entry.propertyName ?? entry.name).text });
        else {
          const symbol = checkerFor(sf).getExportSpecifierLocalTargetSymbol(entry);
          add(entry.name.text, { kind: "declaration", declaration: symbol?.valueDeclaration ?? symbol?.declarations?.[0] });
        }
      }
    }
    if (ts.isExportAssignment(statement)) add("default", { kind: "snapshot", expression: statement.expression });
    if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
      && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const { left, right } = statement.expression;
      const target = isCommonJsExportTarget(left) ? left.getText() : "";
      const property = /^(exports|module\.exports)\.([\w$]+)$/.exec(target);
      if (property) {
        directWrites.add(statement.expression);
        if (property[1] !== "exports" || exportsLinked) exports.commonJs.named.set(property[2], { kind: "snapshot", expression: right });
      }
      if (target === "module.exports") {
        directWrites.add(statement.expression);
        exportsLinked = false;
        exports.commonJs.named.clear();
        exports.commonJs.value = right;
        if (ts.isObjectLiteralExpression(right)) for (const property of right.properties) {
          budget.take();
          const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)
            || ts.isNumericLiteral(property.name)) ? property.name.text : undefined;
          if (name === undefined) { exports.commonJs.named.clear(); continue; }
          exports.commonJs.named.set(name, ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
            ? { kind: "snapshot", expression: ts.isPropertyAssignment(property) ? property.initializer : property.name }
            : { kind: "declaration" });
        }
      }
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) {
      const name = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword) ? "default" : statement.name?.text;
      if (name) add(name, { kind: "declaration", declaration: statement });
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      budget.take();
      if (ts.isIdentifier(declaration.name)) add(declaration.name.text, { kind: "declaration", declaration });
    }
  }
  const exportTarget = (node: ts.Node): boolean => {
    const pending = [node];
    while (pending.length) {
      budget.take();
      let current = pending.pop()!;
      if (ts.isObjectLiteralExpression(current)) {
        for (const property of current.properties) {
          budget.take();
          if (ts.isShorthandPropertyAssignment(property)) pending.push(property.name);
          else if (ts.isPropertyAssignment(property)) pending.push(property.initializer);
          else if (ts.isSpreadAssignment(property)) pending.push(property.expression);
        }
        continue;
      }
      if (ts.isArrayLiteralExpression(current)) {
        for (const element of current.elements) { budget.take(); pending.push(element); }
        continue;
      }
      if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        pending.push(current.left); continue;
      }
      if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
        let first: string | undefined;
        while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
          budget.take();
          first = ts.isPropertyAccessExpression(current) ? current.name.text
            : ts.isStringLiteralLike(current.argumentExpression) ? current.argumentExpression.text : undefined;
          current = current.expression;
        }
        if (ts.isIdentifier(current) && isCommonJsExportTarget(current)
          && (current.text === "exports" || first === "exports" || first === undefined)) return true;
      } else if (ts.isIdentifier(current) && isCommonJsExportTarget(current)) return true;
      ts.forEachChild(current, child => { pending.push(child); });
    }
    return false;
  };
  // Deferred, destructured, computed, and mutator writes cannot establish a
  // final startup export. Classify them once beside the cached export syntax.
  const pending: ts.Node[] = [sf];
  while (pending.length) {
    budget.take(); const node = pending.pop()!;
    const assignment = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
    const target = assignment ? node.left : ts.isDeleteExpression(node) ? node.expression
      : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) ? node.operand : undefined;
    if (target && !directWrites.has(node) && exportTarget(target)) exports.commonJs.uncertain = true;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.arguments.length
      && ts.isIdentifier(node.expression.expression) && ["Object", "Reflect"].includes(node.expression.expression.text)
      && !symbolOf(node.expression.expression)?.declarations?.length
      && ["assign", "defineProperty", "defineProperties", "set", "deleteProperty", "setPrototypeOf"].includes(node.expression.name.text)
      && exportTarget(node.arguments[0])) exports.commonJs.uncertain = true;
    ts.forEachChild(node, child => { pending.push(child); });
  }
  currentExportIndexes.set(sf, { project, exports });
  return exports;
}

const GLOBAL_MODULE = "<native-global>";
const GLOBAL_HOSTS = new Set(["globalThis", "global", "window", "self"]);
const TRACKED_GLOBALS = new Set([...GLOBAL_HOSTS, "fetch", "axios", "process", "queueMicrotask", "setImmediate"]);
function lexicalValue(node: ts.Identifier): boolean {
  return !!symbolOf(node)?.declarations?.some(declaration => ts.isVariableDeclaration(declaration)
    || ts.isBindingElement(declaration) || ts.isParameter(declaration) || ts.isFunctionDeclaration(declaration)
    || ts.isFunctionExpression(declaration) || ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)
    || ts.isImportSpecifier(declaration) || ts.isNamespaceImport(declaration) || ts.isImportClause(declaration)
    || ts.isImportEqualsDeclaration(declaration) || ts.isEnumDeclaration(declaration));
}
function memberName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  return ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
}
function executionOwner(node: ts.Node): ts.Node | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return parent;
    if (ts.isPropertyDeclaration(parent) && !ts.getModifiers(parent)?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)) return parent;
  }
  return undefined;
}
interface NativeMemberWrite extends BindingWrite { receiver?: ts.Expression; global?: string; name?: string }

function capturesInterceptors(pattern: ts.ObjectBindingPattern | ts.ObjectLiteralExpression, budget: AnalysisBudget): boolean {
  // Destructuring copies the interceptor manager by reference. Rest also
  // retains it unless an earlier explicit property already consumed it.
  const properties = ts.isObjectBindingPattern(pattern) ? pattern.elements : pattern.properties;
  let rest = false, consumed = false;
  for (const property of properties) {
    budget.take();
    if (ts.isSpreadAssignment(property) || ts.isBindingElement(property) && property.dotDotDotToken) { rest = true; continue; }
    const name = ts.isBindingElement(property) ? property.propertyName ?? property.name : property.name;
    if (!name) continue;
    const key = ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text
      : ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression) ? name.expression.text : undefined;
    if (key !== undefined && key !== "interceptors") continue;
    if (key === "interceptors") consumed = true;
    const target = ts.isBindingElement(property) ? property.name : ts.isPropertyAssignment(property) ? property.initializer : undefined;
    const nested = target && (ts.isObjectBindingPattern(target) ? target.elements : ts.isObjectLiteralExpression(target) ? target.properties : undefined);
    if (!nested || !nested.every(entry => {
      budget.take();
      if (ts.isSpreadAssignment(entry) || ts.isBindingElement(entry) && entry.dotDotDotToken) return false;
      const name = ts.isBindingElement(entry) ? entry.propertyName ?? entry.name : entry.name;
      return !!name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === "response";
    })) return true;
  }
  return rest && !consumed;
}

interface MemberHistory { entries: BindingWrite[]; list?: ts.Node }
interface NativeMemberFacts {
  writes: Map<string, Map<string | undefined, MemberHistory>>;
}
const nativeMemberFacts = new WeakMap<ts.SourceFile, NativeMemberFacts>();
const nativeMemberFailures = new WeakMap<ts.SourceFile, unknown>();
function namespaceKey(imported: ImportedIdentity, sf: ts.SourceFile): string {
  const origin = currentImportSources.get(imported) ?? sf;
  const local = projectFor(origin)?.resolve(origin.fileName, imported.module);
  if (local) return local;
  if (imported.module === "axios") {
    const instance = axiosInstances.get(imported);
    const client = instance ? `axios\0${instance.getSourceFile().fileName}\0${instance.pos}` : "axios";
    return imported.name === "defaults" ? client + "\0defaults" : client;
  }
  return imported.module.replace(/^node:/, "");
}
interface NamespaceOrigins { keys: readonly string[]; height: number; definite: boolean; blocked?: ReadonlySet<ts.Node> }
const noNamespaces: NamespaceOrigins = { keys: [], height: 0, definite: false };
function possibleNamespaces(expression: ts.Node, use: ts.Node, cache: WeakMap<ts.Node, NamespaceOrigins>,
  seen = new Set<ts.Node>()): NamespaceOrigins {
  const budget = bindingWriteIndex(expression.getSourceFile()).budget; budget.take();
  // Literal arguments cannot be module namespaces. Their nested captures are
  // indexed separately, so unrelated deep metadata must not become a binding
  // dependency of HTTP identity. Erased wrappers still consume scan work.
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression) || ts.isTypeAssertionExpression(expression)) { budget.take(); expression = expression.expression; }
  if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)
    && !ts.isCallExpression(expression) && !ts.isConditionalExpression(expression) && !ts.isBinaryExpression(expression)) return noNamespaces;
  const next = bindingStep(expression, seen); if (!next) return { ...noNamespaces, blocked: new Set([expression]) };
  const imported = currentImportedBinding(expression, use, new Set(), false);
  if (imported) {
    const namespace = ["*", "default"].includes(imported.name) || imported.module === "axios" && imported.name === "defaults";
    return { keys: namespace ? [namespaceKey(imported, expression.getSourceFile())] : [], height: 1, definite: namespace };
  }
  const keys = new Set<string>();
  let height = 0, definite = true, blocked: Set<ts.Node> | undefined;
  const append = (value: ts.Node, observation: ts.Node) => {
    const child = possibleNamespaces(value, observation, cache, next);
    height = Math.max(height, child.height);
    definite &&= child.definite;
    if (child.blocked) {
      blocked ??= new Set();
      for (const ancestor of child.blocked) { budget.take(); blocked.add(ancestor); }
    }
    for (const key of child.keys) { budget.take(); keys.add(key); }
  };
  let capture: ts.Node | undefined;
  if (ts.isConditionalExpression(expression)) {
    append(expression.whenTrue, use); append(expression.whenFalse, use);
  } else if (ts.isBinaryExpression(expression) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken].includes(expression.operatorToken.kind)) {
    append(expression.left, use); append(expression.right, use);
  } else {
    const declaration = ts.isIdentifier(expression) ? symbolOf(expression)?.valueDeclaration : undefined;
    if (!declaration || !ts.isVariableDeclaration(declaration)) return { ...noNamespaces, height: 1 };
    // Different reads may capture different assignments. Only the initializer
    // selected at this observation, or the union of uncertain writes, is reusable.
    const current = currentInitializer(declaration, use);
    capture = current ?? declaration;
    const cached = cache.get(capture);
    if (cached && next.size + cached.height <= MAX_BINDING_DEPTH + 1) return { ...cached, height: cached.height + 1 };
    if (current) append(current, current);
    else {
      definite = false;
      if (declaration.initializer) append(declaration.initializer, declaration.initializer);
      for (const write of bindingWriteIndex(declaration.getSourceFile()).writes.get(declaration) ?? []) {
        budget.take(); if (write.value) append(write.value, write.value);
      }
    }
  }
  const summary = { keys: [...keys], height, definite: definite && keys.size === 1 };
  // Cache only after every back edge within the capture has closed. A cycle
  // cut by an outside caller can hide other origins or a deeper path. A
  // closed cycle is still uncertain, but its union can serve later branches.
  if (capture && !blocked?.size) cache.set(capture, summary);
  blocked?.delete(expression);
  return { ...summary, height: height + 1, blocked: blocked?.size ? blocked : undefined };
}

/** Namespace writes are indexed once using provenance without member proofs.
 * That separate mode prevents a write scan from consuming its own partial facts. */
function memberWrites(sf: ts.SourceFile): NativeMemberFacts {
  const index = bindingWriteIndex(sf);
  if (nativeMemberFailures.has(sf)) throw nativeMemberFailures.get(sf);
  const cached = nativeMemberFacts.get(sf); if (cached) return cached;
  const facts: NativeMemberFacts = { writes: new Map() };
  const captures = new WeakMap<ts.Node, NamespaceOrigins>();
  try {
    for (const write of index.nativeWrites) {
      index.budget.take();
      const origins = write.global ? { keys: [GLOBAL_MODULE], definite: true }
        : write.receiver ? possibleNamespaces(write.receiver, write.node, captures) : noNamespaces;
      if (!origins.keys.length) continue;
      let observed: BindingWrite = write;
      if (!origins.definite) {
        // A method swap on one of several possible clients can still be an
        // HTTP call. Its argument layout cannot be taken from the replacement.
        const replacement = write.value && write.name && AXIOS_METHODS.has(write.name)
          ? currentImportedBinding(write.value, write.value, new Set(), false) : null;
        observed = { ...write, value: undefined, possibleHttp: !!axiosHttpMethod(replacement) };
      }
      for (const key of origins.keys) {
        index.budget.take();
        const name = write.global ?? write.name;
        const names = facts.writes.get(key) ?? new Map<string | undefined, MemberHistory>();
        const statement = write.node.parent;
        const list = ts.isExpressionStatement(statement) && (ts.isSourceFile(statement.parent) || ts.isBlock(statement.parent))
          ? statement.parent : undefined;
        const history: MemberHistory = names.get(name) ?? { entries: [], list };
        if (history.list !== list) history.list = undefined;
        history.entries.push(observed);
        names.set(name, history); facts.writes.set(key, names);
      }
    }
    for (const names of facts.writes.values()) for (const { entries } of names.values()) {
      entries.sort((left, right) => { index.budget.take(); return left.node.pos - right.node.pos; });
    }
    nativeMemberFacts.set(sf, facts); return facts;
  } catch (error) { nativeMemberFailures.set(sf, error); throw error; }
}
function memberWrite(imported: ImportedIdentity, name: string, at: ts.Node, use: ts.Node): BindingWrite | "unknown" | undefined {
  const sf = at.getSourceFile(), index = bindingWriteIndex(sf), facts = memberWrites(sf);
  index.budget.take();
  const key = namespaceKey(imported, sf), names = facts.writes.get(key);
  const exact = names?.get(name), wildcard = names?.get(undefined);
  if (!exact && !wildcard) return undefined;
  const list = (exact ?? wildcard)!.list;
  if (!list || (wildcard && wildcard.list !== list)) return "unknown";
  const afterStartup = list === sf && (use === sf || exportedEntry(use, sf));
  if (!afterStartup && (use.getSourceFile() !== sf || statementList(use) !== list
    || executionOwner(use) !== executionOwner(list))) return "unknown";
  // Keep one ordered history for unknown keys. A named query needs only the
  // latest observation from each of two lists, even for a wide namespace.
  const latest = (history: MemberHistory | undefined): BindingWrite | undefined => {
    if (!history) return undefined;
    if (afterStartup) return history.entries.at(-1);
    let low = 0, high = history.entries.length;
    while (low < high) {
      index.budget.take();
      const middle = (low + high) >>> 1;
      if (history.entries[middle].node.end <= use.pos) low = middle + 1; else high = middle;
    }
    return low ? history.entries[low - 1] : undefined;
  };
  const known = latest(exact), possible = latest(wildcard);
  // An unknown key may affect this member but cannot establish its new value.
  if (possible && (!known || possible.node.end >= known.node.end)) return "unknown";
  if (known?.value && imported.module === "axios" && !axiosInstances.has(imported)) {
    // Cross-directory package lookups and the import/require conditions can
    // select independent clients. A potential write cannot establish a new
    // method signature without evidence both sides observed the same export.
    const receiver = (known as NativeMemberWrite).receiver;
    const writer = receiver && currentImportedBinding(receiver, known.node, new Set(), false);
    if (!writer || axiosLookup(writer, sf) !== axiosLookup(imported, sf)) {
      const replacement = AXIOS_METHODS.has(name) && currentImportedBinding(known.value, known.value, new Set(), false);
      return replacement && axiosHttpMethod(replacement) ? { node: known.node, possibleHttp: true } : "unknown";
    }
  }
  return known;
}
/** Resolve a member from an already-resolved receiver without replaying its
 * caller-owned alias chain. The source node retains the observation point. */
export function currentImportedMember(receiver: ImportedIdentity, name: string, at: ts.Node, use: ts.Node = at): ImportedIdentity | null {
  const seen = bindingStep(at, new Set());
  return seen && ["*", "default"].includes(receiver.name) ? importedMember(receiver, name, at, use, seen, true) : null;
}

type MemberResult = BindingWrite | "unknown" | undefined;
type WriterIndex = Map<string, Map<string | undefined, Set<ts.SourceFile>>>;
const effectGraphs = new WeakMap<SourceProject, ModuleEffects>();
const effectFailures = new WeakMap<SourceProject, unknown>();
const writerGroups = new WeakMap<readonly ts.SourceFile[], WriterIndex>();
const writerGroupFailures = new WeakMap<readonly ts.SourceFile[], unknown>();
const externalWrites = new WeakMap<ts.SourceFile, Map<string, Map<string, Map<boolean, MemberResult>>>>();

function moduleEffects(project: SourceProject): ModuleEffects {
  if (effectFailures.has(project)) throw effectFailures.get(project);
  const cached = effectGraphs.get(project); if (cached) return cached;
  try {
    const effects = new ModuleEffects(project, value => {
      if (ts.isStringLiteralLike(value)) return value.text;
      const declaration = ts.isIdentifier(value) ? symbolOf(value)?.valueDeclaration : undefined;
      return declaration && ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
        && (declaration.parent.flags & ts.NodeFlags.Const) && declaration.initializer && ts.isStringLiteralLike(declaration.initializer)
        ? declaration.initializer.text : undefined;
    });
    effectGraphs.set(project, effects); return effects;
  } catch (error) { effectFailures.set(project, error); throw error; }
}

export function moduleInputsKnown(sf: ts.SourceFile): boolean {
  const project = projectFor(sf);
  return !!project && moduleEffects(project).inputsKnownFor(sf);
}

/** Index mutable namespaces once per group of runtime-linked modules. A
 * sibling's write is definite only when static imports establish its order. */
function externalMemberWrite(receiver: ImportedIdentity, name: string, sf: ts.SourceFile, use: ts.Node): MemberResult {
  const project = projectFor(sf);
  if (!project || project.sources.size < 2) return undefined;
  const effects = moduleEffects(project);
  // Reporting uses actual runtime links. A computed load elsewhere cannot
  // establish that an unrelated writer replaced this call. Patch generation
  // separately requires complete input provenance.
  const group = effects.group(sf);
  if (group.length < 2) return undefined;
  if (writerGroupFailures.has(group)) throw writerGroupFailures.get(group);
  let writers = writerGroups.get(group);
  if (!writers) {
    writers = new Map();
    try {
      for (const file of group) {
        effects.budget.take();
        for (const [key, names] of memberWrites(file).writes) {
          const members = writers.get(key) ?? new Map<string | undefined, Set<ts.SourceFile>>();
          for (const member of names.keys()) {
            effects.budget.take(); const files = members.get(member) ?? new Set<ts.SourceFile>();
            files.add(file); members.set(member, files);
          }
          writers.set(key, members);
        }
      }
      writerGroups.set(group, writers);
    } catch (error) { writerGroupFailures.set(group, error); throw error; }
  }
  effects.budget.take();
  const key = namespaceKey(receiver, sf), members = writers.get(key);
  const exact = members?.get(name), wildcard = members?.get(undefined);
  if ((!exact || exact.size === 1 && exact.has(sf)) && (!wildcard || wildcard.size === 1 && wildcard.has(sf))) return undefined;
  const deferred = use !== sf && !!executionOwner(use);
  const byKey = externalWrites.get(sf) ?? new Map<string, Map<string, Map<boolean, MemberResult>>>();
  const observationKey = receiver.module === "axios" && !axiosInstances.has(receiver) ? key + "\0" + axiosLookup(receiver, sf) : key;
  const byName = byKey.get(observationKey) ?? new Map<string, Map<boolean, MemberResult>>();
  const cached = byName.get(name) ?? new Map<boolean, MemberResult>();
  if (cached.has(deferred)) return cached.get(deferred);
  let result: MemberResult;
  both: for (const candidates of [exact, wildcard]) for (const writer of candidates ?? []) {
    effects.budget.take();
    if (writer === sf || candidates === wildcard && exact?.has(writer)) continue;
    const order = effects.writerOrder(writer, sf);
    // A downstream importer executes after top-level captures in this file.
    if (!deferred && order === "after") continue;
    if (order !== "before" || result) { result = "unknown"; break both; }
    result = memberWrite(receiver, name, writer, writer);
    if (result === "unknown") break both;
  }
  cached.set(deferred, result); byName.set(name, cached); byKey.set(observationKey, byName); externalWrites.set(sf, byKey);
  return result;
}

function observedMemberWrite(receiver: ImportedIdentity, name: string, at: ts.Node, use: ts.Node): MemberResult {
  const inherited = externalMemberWrite(receiver, name, at.getSourceFile(), use);
  if (inherited === "unknown") return inherited;
  return memberWrite(receiver, name, at, use) ?? inherited;
}
function importedMember(receiver: ImportedIdentity, name: string, at: ts.Node, use: ts.Node,
  seen: Set<ts.Node>, members: boolean): ImportedIdentity | null {
  const origin = currentImportSources.get(receiver);
  if (members) {
    const write = observedMemberWrite(receiver, name, at, use);
    if (write) return write !== "unknown" && write.value ? currentImportedBinding(write.value, write.value, seen, members) : null;
  }
  const sf = origin ?? at.getSourceFile();
  if (receiver.module === "axios" && !projectFor(sf)?.resolve(sf.fileName, receiver.module)) return axiosIdentity(name, sf, axiosInstances.get(receiver), axiosLoads.get(receiver));
  if (receiver.module === GLOBAL_MODULE) {
    if (name === "process") {
      const processNamespace = { module: "node:process", name: "*" };
      currentImportSources.set(processNamespace, sf);
      return processNamespace;
    }
    const imported = name === "axios" ? axiosIdentity("default", sf, undefined, "global")
      : { module: GLOBAL_MODULE, name: GLOBAL_HOSTS.has(name) ? "*" : name };
    currentImportSources.set(imported, sf); return imported;
  }
  return currentModuleImport(sf, receiver.module, name, seen, members);
}

function currentModuleImport(sf: ts.SourceFile, module: string, name: string, seen: Set<ts.Node>, members = true): ImportedIdentity | null {
  const project = projectFor(sf), rel = project?.resolve(sf.fileName, module);
  if (!rel) {
    const imported = { module, name };
    currentImportSources.set(imported, sf);
    return imported;
  }
  const target = project!.sources.get(rel)!, next = bindingStep(target, seen);
  if (!next) return null;
  const budget = bindingWriteIndex(target).budget, exports = currentModuleExports(target);
  budget.take();
  const entry = exports.named.get(name);
  const commonJs = !exports.commonJs.uncertain ? exports.commonJs : undefined;
  const value = entry ?? (name === "default" && commonJs?.value ? { kind: "snapshot" as const, expression: commonJs.value }
    : name !== "default" ? commonJs?.named.get(name) : undefined);
  if (value) {
    if (value.kind === "namespace") {
      const imported = { module: value.module, name: "*" };
      currentImportSources.set(imported, target); return imported;
    }
    if (value.kind === "forward") return currentModuleImport(target, value.module, value.name, next, members);
    // Unlike a named live binding, default/CJS export expressions capture once.
    if (value.kind === "snapshot") return currentImportedBinding(value.expression, value.expression, next, members);
    const declaration = value.declaration;
    if (!declaration || !(ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration)
      || ts.isImportSpecifier(declaration) || ts.isNamespaceImport(declaration) || ts.isImportClause(declaration))
      || !declaration.name || !ts.isIdentifier(declaration.name)) return null;
    // ESM named exports observe the final startup binding. Aliases stored in
    // that binding capture their sources at their own initializer sites.
    return currentImportedBinding(declaration.name, target, next, members);
  }
  if (commonJs?.value) {
    const imported = currentImportedBinding(commonJs.value, commonJs.value, next, members);
    if (imported?.name === "*") return currentModuleImport(currentImportSources.get(imported) ?? target, imported.module, name, next, members);
  }
  for (const source of exports.stars) {
    budget.take();
    const imported = currentModuleImport(target, source, name, next, members);
    if (imported) return imported;
  }
  return null;
}

/** Import identity at the value's observation point. Each alias captures the
 * value at its initializer, rather than adopting later writes to its source. */
export function currentImportedBinding(node: ts.Node, use: ts.Node = node, seen = new Set<ts.Node>(), members = true): ImportedIdentity | null {
  if (seen.size) return resolveCurrentImport(node, use, seen, members);
  const project = projectFor(node.getSourceFile());
  const cache = currentImports[members ? 1 : 0];
  const reads = cache.get(node) ?? new WeakMap();
  const cached = reads.get(use);
  if (cached && cached.project === project) return cached.imported;
  const imported = resolveCurrentImport(node, use, seen, members);
  reads.set(use, { project, imported }); cache.set(node, reads);
  return imported;
}
function resolveCurrentImport(node: ts.Node, use: ts.Node, seen: Set<ts.Node>, members = true): ImportedIdentity | null {
  const next = bindingStep(node, seen);
  if (!next) return null;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return currentImportedBinding(node.expression, use, next, members);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const name = ts.isPropertyAccessExpression(node) ? node.name.text
      : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
    const receiver = currentImportedBinding(node.expression, use, next, members);
    if (!receiver || !["*", "default"].includes(receiver.name) || name === undefined) return null;
    return importedMember(receiver, name, node, use, next, members);
  }
  if (ts.isCallExpression(node) && isCommonJsRequire(node.expression, members) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
    if (node.arguments[0].text === "axios") return axiosIdentity("*", node.getSourceFile(), undefined, "require");
    const imported = { module: node.arguments[0].text, name: "*" };
    currentImportSources.set(imported, node.getSourceFile());
    return imported;
  }
  if (ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))
    && memberName(node.expression) === "create") {
    const factory = currentImportedBinding(node.expression, node.expression, next, members);
    if (factory?.module === "axios" && factory.name === "create") return axiosIdentity("*", node.getSourceFile(), node);
  }
  if (ts.isIdentifier(node) && !lexicalValue(node) && TRACKED_GLOBALS.has(node.text)) {
    const receiver: ImportedIdentity = { module: GLOBAL_MODULE, name: "*" };
    currentImportSources.set(receiver, node.getSourceFile());
    return importedMember(receiver, node.text, node, use, next, members);
  }
  const declaration = ts.isVariableDeclaration(node) ? node : symbolOf(node)?.valueDeclaration ?? symbolOf(node)?.declarations?.[0];
  if (declaration && ts.isImportEqualsDeclaration(declaration) && !declaration.isTypeOnly && ts.isExternalModuleReference(declaration.moduleReference)
    && ts.isStringLiteralLike(declaration.moduleReference.expression)) {
    const specifier = declaration.moduleReference.expression.text;
    if (specifier === "axios") return axiosIdentity("*", declaration.getSourceFile(), undefined, "require");
    const imported = { module: specifier, name: "*" };
    currentImportSources.set(imported, declaration.getSourceFile()); return imported;
  }
  if (declaration && ts.isVariableDeclaration(declaration)) {
    const declared = declaration === node ? next : bindingStep(declaration, next);
    if (!declared) return null;
    let value = currentInitializer(declaration, use);
    if (!value) {
      const index = bindingWriteIndex(declaration.getSourceFile()), writes = index.writes.get(declaration);
      const history = writes?.length ? writeHistory(declaration, writes, index) : undefined;
      if (history?.entries && history.list === declaration.getSourceFile()
        && (use === declaration.getSourceFile() || exportedEntry(use, declaration.getSourceFile()))) {
        value = history.entries[history.entries.length - 1].value;
      }
    }
    return value ? currentImportedBinding(value, value, declared, members) : null;
  }
  if (declaration && ts.isBindingElement(declaration)) {
    const declared = bindingStep(declaration, next);
    if (!declared) return null;
    if (bindingWriteIndex(declaration.getSourceFile()).writes.has(declaration)) return null;
    const variable = declaration.parent.parent;
    if (!ts.isVariableDeclaration(variable) || !variable.initializer || !ts.isIdentifier(declaration.name)) return null;
    const receiver = currentImportedBinding(variable.initializer, variable.initializer, declared, members);
    const name = declaration.propertyName ?? declaration.name;
    if (!receiver || !["*", "default"].includes(receiver.name) || !ts.isIdentifier(name) && !ts.isStringLiteralLike(name)) return null;
    return importedMember(receiver, name.text, variable.initializer, variable.initializer, declared, members);
  }
  if (!declaration || !ts.isImportSpecifier(declaration) && !ts.isNamespaceImport(declaration) && !ts.isImportClause(declaration)) return null;
  let statement: ts.Node | undefined = declaration.parent;
  while (statement && !ts.isImportDeclaration(statement)) statement = statement.parent;
  if (!statement || !ts.isStringLiteral(statement.moduleSpecifier)) return null;
  const name = ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text
    : ts.isNamespaceImport(declaration) ? "*" : "default";
  if (name !== "*") return currentModuleImport(declaration.getSourceFile(), statement.moduleSpecifier.text, name, next, members);
  const imported = { module: statement.moduleSpecifier.text, name };
  currentImportSources.set(imported, declaration.getSourceFile());
  return imported;
}

/** HTTP identity follows the value observed at the call, including captured
 * aliases. Visible replacement must not regain native proof by its spelling. */
export function nativeScheduler(node: ts.Expression): "queueMicrotask" | "setImmediate" | "nextTick" | undefined {
  const imported = currentImportedBinding(node);
  if (!imported) return undefined;
  if (imported.module === GLOBAL_MODULE && (imported.name === "queueMicrotask" || imported.name === "setImmediate")) return imported.name;
  if (/^(?:node:)?timers$/.test(imported.module) && imported.name === "setImmediate") return "setImmediate";
  if (/^(?:node:)?process$/.test(imported.module) && imported.name === "nextTick") return "nextTick";
  return undefined;
}

export function isHttpFetch(node: ts.Expression): boolean {
  const imported = currentImportedBinding(node);
  return !!imported && (imported.module === GLOBAL_MODULE && imported.name === "fetch"
    || ["undici", "node-fetch", "cross-fetch"].includes(imported.module) && ["fetch", "default"].includes(imported.name));
}

export function isNativeFetch(node: ts.Expression): boolean {
  const imported = currentImportedBinding(node);
  return imported?.module === GLOBAL_MODULE && imported.name === "fetch";
}
const AXIOS_BODY_METHODS = new Set(["post", "put", "patch", "postForm", "putForm", "patchForm"]);
const AXIOS_METHODS = new Set(["get", "delete", "head", "options", "request", ...AXIOS_BODY_METHODS]);
export function axiosBodyMethod(method: string): boolean { return AXIOS_BODY_METHODS.has(method); }
export function isAxiosBinding(expr: ts.Expression): boolean {
  const imported = currentImportedBinding(expr);
  return imported?.module === "axios" && ["default", "*"].includes(imported.name);
}
export function isAxiosMethod(expr: ts.Expression, method?: string): boolean {
  const imported = currentImportedBinding(expr);
  return imported?.module === "axios" && !["default", "*"].includes(imported.name)
    && (method === undefined ? AXIOS_METHODS.has(imported.name) : imported.name === method);
}
export function axiosHttpMethod(imported: ImportedIdentity | null): string | undefined {
  if (imported?.module !== "axios") return undefined;
  return ["default", "*"].includes(imported.name) ? "axios" : AXIOS_METHODS.has(imported.name) ? imported.name : undefined;
}
export function isAxiosCall(expr: ts.Expression): boolean {
  return axiosHttpMethod(currentImportedBinding(expr)) !== undefined;
}
export function axiosInstance(imported: ImportedIdentity): ts.CallExpression | undefined { return axiosInstances.get(imported); }
export function axiosRequestInterceptorsObserved(imported: ImportedIdentity, at: ts.Node): boolean {
  return !!observedMemberWrite(imported, "interceptors", at, at);
}
export function uncertainAxiosMethod(receiver: ImportedIdentity, name: string, at: ts.Node): boolean {
  if (receiver.module !== "axios" || !AXIOS_METHODS.has(name)) return false;
  const write = observedMemberWrite(receiver, name, at, at);
  return write === "unknown" ? axiosInstances.has(receiver) : !!write && (!!write.possibleHttp || axiosInstances.has(receiver) && !write.value);
}
export { uncertainAxiosMethod as uncertainAxiosInstanceMethod };

export interface AxiosDefaults { timeout?: ts.Expression; signal?: ts.Expression; changed: boolean; unknown: boolean }
/** Mutable defaults belong to the client a method was bound to. A created
 * client copies the singleton options at create(), then has its own defaults. */
export function axiosDefaultsAt(imported: ImportedIdentity, at: ts.Node): AxiosDefaults {
  const origin = currentImportSources.get(imported) ?? at.getSourceFile(), instance = axiosInstances.get(imported);
  const load = axiosLoads.get(imported);
  const receiver = axiosIdentity("*", origin, instance, load), defaults = axiosIdentity("defaults", origin, instance, load);
  const object = observedMemberWrite(receiver, "defaults", at, at);
  const timeout = observedMemberWrite(defaults, "timeout", at, at), signal = observedMemberWrite(defaults, "signal", at, at);
  return {
    changed: !!(object || timeout || signal),
    unknown: !!object || timeout === "unknown" || signal === "unknown" || !!timeout && !timeout.value || !!signal && !signal.value,
    timeout: !object && timeout && timeout !== "unknown" ? timeout.value : undefined,
    signal: !object && signal && signal !== "unknown" ? signal.value : undefined,
  };
}

export interface BindingWrite { node: ts.Node; value?: ts.Expression; target?: ts.Expression; possibleHttp?: boolean }
export interface WriteIndex { writes: Map<ts.Declaration, BindingWrite[]>; references: Set<ts.Declaration>; budget: AnalysisBudget; nativeWrites: NativeMemberWrite[] }
type InitializerDeclaration = ts.VariableDeclaration | ts.PropertyAssignment | ts.PropertyDeclaration;
const bindingWrites = new WeakMap<ts.SourceFile, WriteIndex>();
const bindingWriteFailures = new WeakMap<ts.SourceFile, unknown>();
const straightLineWrites = new WeakMap<InitializerDeclaration, { list: ts.Node | undefined; entries?: BindingWrite[] }>();
const initializerReads = new WeakMap<InitializerDeclaration, WeakMap<ts.Node, ts.Expression | null>>();

export function statementList(node: ts.Node): ts.Block | ts.SourceFile | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) if (ts.isBlock(parent) || ts.isSourceFile(parent)) return parent;
  return undefined;
}

export function bindingWriteIndex(sf: ts.SourceFile): WriteIndex {
  if (bindingWriteFailures.has(sf)) throw bindingWriteFailures.get(sf);
  const cached = bindingWrites.get(sf); if (cached) return cached;
  const result: WriteIndex = { writes: new Map(), references: new Set(), budget: new AnalysisBudget("Promise binding writes", projectWorkLimit([sf])), nativeWrites: [] };
  const propertyWrites: Array<{ target: ts.PropertyAccessExpression | ts.ElementAccessExpression; node: ts.Node; value?: ts.Expression }> = [];
  const add = (target: ts.Node, node: ts.Node, value?: ts.Expression): void => {
    result.budget.take();
    if (ts.isIdentifier(target)) {
      if (!lexicalValue(target) && TRACKED_GLOBALS.has(target.text)) {
        result.nativeWrites.push({ global: target.text, node, value });
      }
      const declaration = symbolOf(target)?.valueDeclaration;
      if (declaration) { const entries = result.writes.get(declaration) ?? []; entries.push({ node, value }); result.writes.set(declaration, entries); }
    } else if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
      propertyWrites.push({ target, node, value });
      result.nativeWrites.push({ receiver: target.expression, name: memberName(target), node, value });
    } else if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isShorthandPropertyAssignment(property)) add(property.name, node);
        else if (ts.isPropertyAssignment(property)) add(property.initializer, node);
        else if (ts.isSpreadAssignment(property)) add(property.expression, node);
      }
    } else if (ts.isArrayLiteralExpression(target)) for (const element of target.elements) add(element, node);
    else if (ts.isSpreadElement(target)) add(target.expression, node);
    else if (ts.isBinaryExpression(target)) add(target.left, node);
  };
  const pending: ts.Node[] = [sf];
  while (pending.length) {
    result.budget.take(); const node = pending.pop()!;
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name)
      && capturesInterceptors(node.name, result.budget)) {
      result.nativeWrites.push({ receiver: node.initializer, name: "interceptors", node });
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isObjectLiteralExpression(node.left) && capturesInterceptors(node.left, result.budget)) {
      result.nativeWrites.push({ receiver: node.right, name: "interceptors", node });
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && memberName(node) === "interceptors") {
      const group = node.parent;
      // A response interceptor runs after dispatch. A captured manager or
      // request interceptor can change the effective deadline just before it.
      const groupName = (ts.isPropertyAccessExpression(group) || ts.isElementAccessExpression(group))
        && group.expression === node && memberName(group);
      if (groupName !== "response") {
        const method = group.parent;
        const usesManager = groupName === "request" && (ts.isPropertyAccessExpression(method) || ts.isElementAccessExpression(method))
          && method.expression === group && memberName(method) === "use" && ts.isCallExpression(method.parent) && method.parent.expression === method;
        result.nativeWrites.push({ receiver: node.expression, name: "interceptors", node: usesManager ? method.parent : node });
      }
    }
    if (ts.isIdentifier(node)) {
      const declaration = symbolOf(node)?.valueDeclaration;
      if (declaration && (ts.isVariableDeclaration(declaration) || ts.isFunctionDeclaration(declaration)) && declaration.name !== node) result.references.add(declaration);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      add(node.left, node, node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && (ts.isIdentifier(node.left) || ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) ? node.right : undefined);
    } else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) add(node.operand, node);
    else if (ts.isDeleteExpression(node)) add(node.expression, node);
    else if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) add(node.initializer, node);
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression, argumentsList = node.arguments ?? [];
      const host = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && !lexicalValue(callee.expression)
        ? callee.expression.text : undefined;
      const mutator = (host === "Object" || host === "Reflect") && ts.isPropertyAccessExpression(callee)
        && ["assign", "defineProperty", "defineProperties", "set", "deleteProperty", "setPrototypeOf"].includes(callee.name.text);
      if (mutator && argumentsList[0]) {
        const key = ts.isPropertyAccessExpression(callee) && ["defineProperty", "set", "deleteProperty"].includes(callee.name.text)
          && argumentsList[1] && ts.isStringLiteralLike(argumentsList[1]) ? argumentsList[1].text : undefined;
        result.nativeWrites.push({ receiver: argumentsList[0], name: key, node });
      } else if (host !== "Object" && host !== "Reflect") {
        // An opaque consumer can replace methods on an escaped namespace.
        for (const argument of argumentsList) { result.budget.take(); result.nativeWrites.push({ receiver: argument, node }); }
      }
    }
    if (ts.isReturnStatement(node) && node.expression || ts.isPropertyDeclaration(node) && node.initializer) {
      result.nativeWrites.push({ receiver: ts.isReturnStatement(node) ? node.expression : (node as ts.PropertyDeclaration).initializer, node });
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))) {
      result.nativeWrites.push({ receiver: node.right, node });
    }
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      result.nativeWrites.push({ receiver: ts.isPropertyAssignment(node) ? node.initializer : node.name, node });
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) { result.budget.take(); result.nativeWrites.push({ receiver: ts.isSpreadElement(element) ? element.expression : element, node }); }
    }
    ts.forEachChild(node, child => { pending.push(child); });
  }
  for (const entries of result.writes.values()) entries.sort((a, b) => { result.budget.take(); return a.node.pos - b.node.pos; });
  // Identifier histories are complete before resolving property declarations:
  // a CommonJS property may itself depend on a mutable createRequire alias.
  bindingWrites.set(sf, result);
  try {
    for (const write of propertyWrites) {
      result.budget.take(); const target = write.target;
      const key = ts.isElementAccessExpression(target) && (ts.isStringLiteralLike(target.argumentExpression) || ts.isNumericLiteral(target.argumentExpression)) ? target.argumentExpression : target;
      const declaration = symbolOf(key)?.valueDeclaration ?? definitionOf(target);
      if (declaration && (ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration))) {
        const entries = result.writes.get(declaration) ?? [];
        entries.push(write); result.writes.set(declaration, entries);
      }
    }
    for (const entries of result.writes.values()) if (entries[0]?.target) entries.sort((a, b) => { result.budget.take(); return a.node.pos - b.node.pos; });
  } catch (error) {
    // Reentrant readers need the identifier phase, but a failed property phase
    // must never turn its published partial index into completed evidence.
    bindingWriteFailures.set(sf, error);
    throw error;
  }
  return result;
}

function writeHistory(declaration: InitializerDeclaration, writes: BindingWrite[], index: WriteIndex): { list: ts.Node | undefined; entries?: BindingWrite[] } {
  let checked = straightLineWrites.get(declaration);
  if (!checked) {
    const list = statementList(declaration);
    const valid = !!list && writes.every(write => {
      index.budget.take();
      const statement = write.node.parent;
      return ts.isExpressionStatement(statement) && statement.parent === list && !!write.value;
    });
    checked = { list, entries: valid ? writes : undefined };
    straightLineWrites.set(declaration, checked);
  }
  return checked;
}

export function precedingInitializer(declaration: InitializerDeclaration, use: ts.Node, entries: BindingWrite[], budget: AnalysisBudget): ts.Expression | undefined {
  let low = 0, high = entries.length;
  while (low < high) {
    budget.take();
    const middle = (low + high) >>> 1;
    if (entries[middle].node.end <= use.pos) low = middle + 1;
    else high = middle;
  }
  return low ? entries[low - 1].value : declaration.initializer;
}

/** Resolve only assignments that dominate the use in the same straight-line list.
 * Branch/nested writes invalidate initializer evidence instead of inventing flow. */
export function currentInitializer(declaration: ts.VariableDeclaration, use: ts.Node): ts.Expression | undefined {
  const index = bindingWriteIndex(declaration.getSourceFile());
  index.budget.take();
  let reads = initializerReads.get(declaration);
  if (!reads) { reads = new WeakMap(); initializerReads.set(declaration, reads); }
  const cached = reads.get(use);
  if (cached !== undefined) return cached ?? undefined;
  const finish = (value?: ts.Expression) => { reads!.set(use, value ?? null); return value; };
  const writes = index.writes.get(declaration);
  if (!writes?.length) return finish(declaration.initializer);
  const checked = writeHistory(declaration, writes, index);
  if (!checked.entries || statementList(use) !== checked.list || declaration.getSourceFile() !== use.getSourceFile()
    || executionOwner(use) !== executionOwner(declaration)) return finish();
  return finish(precedingInitializer(declaration, use, checked.entries, index.budget));
}

/** An exported entry with no local references is reached externally after
 * module initialization. Local references may invoke it during startup, so
 * those entries cannot use the final startup value as proof. */
export function exportedEntry(use: ts.Node, sf: ts.SourceFile): boolean {
  let entry: ts.Node | undefined;
  for (let node: ts.Node | undefined = use; node && node !== sf; node = node.parent) {
    if (ts.isFunctionLike(node)) entry = node;
  }
  if (!entry) return false;
  if (ts.isFunctionDeclaration(entry) && entry.parent === sf) return !bindingWriteIndex(sf).references.has(entry) && !!ts.getModifiers(entry)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
  if ((ts.isArrowFunction(entry) || ts.isFunctionExpression(entry)) && ts.isVariableDeclaration(entry.parent)) {
    const statement = entry.parent.parent.parent;
    return !bindingWriteIndex(sf).references.has(entry.parent) && ts.isVariableStatement(statement) && statement.parent === sf && !!ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
  }
  return false;
}

const retainedBindings = new WeakMap<ts.VariableDeclaration, boolean>();
const retainingGuards = new WeakMap<ts.VariableDeclaration, WeakMap<ts.IfStatement, boolean>>();
const guardCompletion = new WeakMap<ts.IfStatement, { exit: number; suspension: number }>();
function unwrapBindingValue(value: ts.Expression, budget: AnalysisBudget): ts.Expression {
  while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isSatisfiesExpression(value)
    || ts.isNonNullExpression(value) || ts.isTypeAssertionExpression(value)) { budget.take(); value = value.expression; }
  return value;
}
function truthyBindingWrite(write: BindingWrite, declaration: ts.VariableDeclaration, budget: AnalysisBudget): boolean {
  budget.take();
  if (ts.isBinaryExpression(write.node) && [ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(write.node.operatorToken.kind)) return true;
  if (!write.value) return false;
  const value = unwrapBindingValue(write.value, budget);
  return ts.isIdentifier(value) && symbolOf(value)?.valueDeclaration === declaration
    || ts.isNewExpression(value) || ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value)
    || ts.isFunctionExpression(value) || ts.isArrowFunction(value) || ts.isClassExpression(value)
    || conditionTruth(value, budget) === true;
}
function guardKeepsBinding(guard: ts.IfStatement, declaration: ts.VariableDeclaration, index: WriteIndex): boolean {
  index.budget.take();
  const memo = retainingGuards.get(declaration) ?? new WeakMap<ts.IfStatement, boolean>(); retainingGuards.set(declaration, memo);
  const cached = memo.get(guard); if (cached !== undefined) return cached;
  const body = guard.thenStatement, owner = executionOwner(guard);
  let initialized = -1, invalidated = -1;
  const entries = index.writes.get(declaration) ?? [];
  let low = 0, high = entries.length;
  while (low < high) { index.budget.take(); const middle = (low + high) >>> 1; if (entries[middle].node.pos < body.pos) low = middle + 1; else high = middle; }
  for (let i = low; i < entries.length && entries[i].node.end <= body.end; i++) {
    index.budget.take(); const write = entries[i];
    if (!truthyBindingWrite(write, declaration, index.budget)) {
      invalidated = Math.max(invalidated, executionOwner(write.node) === owner ? write.node.end : Infinity); continue;
    }
    // Only a direct unconditional assignment guarantees the retained state.
    if (!write.value || !ts.isBinaryExpression(write.node) || write.node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    let current: ts.Node = write.node;
    while (current.parent && (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent)
      || ts.isSatisfiesExpression(current.parent) || ts.isNonNullExpression(current.parent) || ts.isTypeAssertionExpression(current.parent))) { index.budget.take(); current = current.parent; }
    if (!ts.isExpressionStatement(current.parent)) continue;
    current = current.parent;
    while (current !== body && current.parent && ts.isBlock(current.parent)) { index.budget.take(); current = current.parent; }
    if (current === body) initialized = Math.max(initialized, write.node.end);
  }
  let flow = guardCompletion.get(guard);
  if (!flow) {
    flow = { exit: Infinity, suspension: Infinity };
    const pending: ts.Node[] = [body];
    while (pending.length) {
      index.budget.take(); const node = pending.pop()!;
      if (ts.isFunctionLike(node)) continue;
      if (ts.isReturnStatement(node) || ts.isThrowStatement(node) || ts.isBreakStatement(node) || ts.isContinueStatement(node)) flow.exit = Math.min(flow.exit, node.pos);
      if (ts.isAwaitExpression(node) || ts.isYieldExpression(node) || ts.isForOfStatement(node) && node.awaitModifier) flow.suspension = Math.min(flow.suspension, node.pos);
      ts.forEachChild(node, child => { pending.push(child); });
    }
    guardCompletion.set(guard, flow);
  }
  const retained = initialized > invalidated && initialized < flow.exit && initialized < flow.suspension;
  memo.set(guard, retained); return retained;
}
/** A once-only guard cannot prove reuse when another visible write can clear
 * its shared binding on later invocations. Startup writes and retained guard
 * blocks are distinguished from resets in handlers, callbacks and finally. */
export function retainsSharedBinding(declaration: ts.VariableDeclaration): boolean {
  const sf = declaration.getSourceFile(), index = bindingWriteIndex(sf); index.budget.take();
  const cached = retainedBindings.get(declaration); if (cached !== undefined) return cached;
  for (const write of index.writes.get(declaration) ?? []) {
    index.budget.take();
    if (truthyBindingWrite(write, declaration, index.budget)) continue;
    const owner = executionOwner(write.node);
    if (!owner && ts.isExpressionStatement(write.node.parent) && write.node.parent.parent === sf) continue;
    if (owner && ts.isFunctionDeclaration(owner) && owner.parent === sf && !index.references.has(owner)
      && !ts.getModifiers(owner)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    let protectedWrite = false;
    for (let parent = write.node.parent; parent && !ts.isFunctionLike(parent); parent = parent.parent) {
      index.budget.take();
      if (!ts.isIfStatement(parent)) continue;
      const condition = unwrapBindingValue(parent.expression, index.budget);
      const tested = ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken ? condition.operand
        : ts.isBinaryExpression(condition) && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(condition.operatorToken.kind)
          && (condition.right.kind === ts.SyntaxKind.NullKeyword || ts.isIdentifier(condition.right) && condition.right.text === "undefined" && !lexicalValue(condition.right)) ? condition.left : undefined;
      if (!tested || !ts.isIdentifier(tested) || symbolOf(tested)?.valueDeclaration !== declaration
        || write.node.pos < parent.thenStatement.pos || write.node.end > parent.thenStatement.end) continue;
      if (guardKeepsBinding(parent, declaration, index)) { protectedWrite = true; break; }
    }
    if (!protectedWrite) { retainedBindings.set(declaration, false); return false; }
  }
  retainedBindings.set(declaration, true); return true;
}
