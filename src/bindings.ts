import ts from "typescript";
import { SourceProject } from "./project.js";
import { AnalysisLimitError } from "./analysisBudget.js";

const projects = new WeakMap<ts.SourceFile, SourceProject>();
export async function initializeBindings(root: string, sources: { rel: string; sf: ts.SourceFile }[]): Promise<void> {
  const project = await SourceProject.create(root, sources);
  for (const unit of sources) projects.set(unit.sf, project);
}
export function projectFor(sf: ts.SourceFile): SourceProject | undefined { return projects.get(sf); }
interface Binding { declaration?: ts.Declaration; imported?: { module: string; name: string } }

/** Cycles are unknown identities; exhausted traversal is incomplete analysis. */
function bindingStep(node: ts.Node, seen: Set<ts.Node>): Set<ts.Node> | undefined {
  if (seen.has(node)) return undefined;
  if (seen.size > 128) throw new AnalysisLimitError("Binding resolution depth limit exceeded");
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
  // Explicit exports override star exports, regardless of source order.
  const star = (statement: ts.Statement) => ts.isExportDeclaration(statement) && !statement.exportClause;
  for (const statement of [...sf.statements.filter(statement => !star(statement)), ...sf.statements.filter(star)]) {
    if (ts.isExportDeclaration(statement)) {
      const module = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
      if (statement.isTypeOnly) continue;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        const entry = statement.exportClause.elements.find(e => !e.isTypeOnly && e.name.text === name);
        if (entry) {
          const original = (entry.propertyName ?? entry.name).text;
          if (module) return moduleBinding(sf, module, original, next);
          const symbol = checkerFor(sf).getExportSpecifierLocalTargetSymbol(entry);
          return declarationBinding(symbol?.valueDeclaration ?? symbol?.declarations?.[0], next);
        }
      } else if (!statement.exportClause && module) {
        const found = moduleBinding(sf, module, name, next);
        if (found.declaration || found.imported) return found;
      }
    }
    if (ts.isExportAssignment(statement) && name === "default") {
      return ts.isIdentifier(statement.expression) ? bindingOf(statement.expression, next) : { declaration: statement };
    }
    if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
      && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const { left, right } = statement.expression;
      const exported = left.getText();
      const valueBinding = (value: ts.Expression): Binding => bindingOf(value, next);
      if (exported === `exports.${name}` || exported === `module.exports.${name}`) return valueBinding(right);
      if (exported === "module.exports") {
        if (ts.isCallExpression(right) && right.expression.getText() === "require" && right.arguments[0] && ts.isStringLiteral(right.arguments[0])) {
          return moduleBinding(sf, right.arguments[0].text, name, next);
        }
        if (ts.isObjectLiteralExpression(right)) for (const property of right.properties) {
          if ((ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && property.name.getText().replace(/['"]/g, "") === name) {
            return valueBinding(ts.isPropertyAssignment(property) ? property.initializer : property.name);
          }
        }
        if (name === "default") return valueBinding(right);
      }
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const isDefault = modifiers.some(m => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) {
      if ((isDefault && name === "default") || (!isDefault && statement.name?.text === name)) return { declaration: statement };
    }
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declarationBinding(declaration, next);
    }
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
    if (ts.isCallExpression(call) && call.expression.getText() === "require" && call.arguments[0] && ts.isStringLiteral(call.arguments[0])) {
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
    if (ts.isCallExpression(node.expression) && node.expression.expression.getText() === "require"
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

/** Local functions/parameters named fetch are not the global HTTP implementation. */
export function isHttpFetch(node: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(node) && node.name.text === "fetch" && ts.isIdentifier(node.expression)) {
    const receiver = node.expression;
    if (receiver.text === "globalThis" && !symbolOf(receiver)?.declarations?.length) return true;
    const imported = importedBinding(receiver);
    return !!imported && imported.module === "undici" && ["*", "default"].includes(imported.name);
  }
  if (!ts.isIdentifier(node)) return false;
  const imported = importedBinding(node);
  if (imported) return ["undici", "node-fetch", "cross-fetch"].includes(imported.module) && ["fetch", "default"].includes(imported.name);
  return node.text === "fetch" && !symbolOf(node)?.declarations?.length;
}

export function isAxiosBinding(expr: ts.Expression): boolean {
  if (!ts.isIdentifier(expr)) return false;
  const imported = importedBinding(expr);
  return imported ? imported.module === "axios" && ["default", "*"].includes(imported.name) : expr.text === "axios" && !symbolOf(expr)?.declarations?.length;
}
