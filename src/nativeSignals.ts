import ts from "typescript";
import { checkerFor } from "./bindings.js";
import { AnalysisBudget, projectWorkLimit } from "./analysisBudget.js";

type NativeName = "AbortSignal" | "Request" | "fetch" | "axios";
const facts = new WeakMap<ts.SourceFile, Map<NativeName, boolean>>();
const failures = new WeakMap<ts.SourceFile, Map<NativeName, unknown>>();
const hosts = new Set(["globalThis", "global", "window", "self"]);
const methods: Record<NativeName, readonly string[]> = {
  AbortSignal: ["timeout", "any", "abort"], Request: [], fetch: [],
  axios: ["get", "delete", "head", "options", "post", "put", "patch", "postForm", "putForm", "patchForm", "request", "create"],
};

/** Visible mutation or escape cannot establish a native timer factory. Share
 * one charged source scan between timeout proof and safe patch generation. */
export function nativeAbortSignalUnchanged(sf: ts.SourceFile): boolean {
  return nativeGlobalUnchanged(sf, "AbortSignal");
}

export function nativeRequestUnchanged(sf: ts.SourceFile): boolean {
  return nativeGlobalUnchanged(sf, "Request");
}

/** Automatic edits must also preserve calls when a different analyzed module
 * replaces a global HTTP function. Unknown host escapes keep edits manual. */
export function nativeHttpGlobalsUnchanged(sf: ts.SourceFile): boolean {
  return nativeGlobalUnchanged(sf, "fetch") && nativeGlobalUnchanged(sf, "axios");
}

function nativeGlobalUnchanged(sf: ts.SourceFile, name: NativeName): boolean {
  if (failures.get(sf)?.has(name)) throw failures.get(sf)!.get(name);
  const known = facts.get(sf)?.get(name);
  if (known !== undefined) return known;
  const budget = new AnalysisBudget(name === "AbortSignal" ? "Native timer identity" : "Native HTTP identity", projectWorkLimit([sf]));
  const checker = checkerFor(sf);
  const shadows = new WeakMap<ts.Symbol, boolean>();
  const unshadowed = (node: ts.Identifier): boolean => {
    budget.take();
    const symbol = checker.resolveName(node.text, node, ts.SymbolFlags.Value | ts.SymbolFlags.Alias, false);
    if (!symbol) return true;
    const cached = shadows.get(symbol);
    if (cached !== undefined) return !cached;
    // In JavaScript, assigning a property can create a synthetic Identifier
    // declaration. That is mutation evidence, not a lexical shadow of a global.
    const shadowed = (symbol.declarations ?? []).some(declaration => {
      budget.take();
      return ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration) || ts.isParameter(declaration)
        || ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration) || ts.isClassLike(declaration)
        || ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)
        || ts.isImportEqualsDeclaration(declaration) || ts.isEnumDeclaration(declaration) || ts.isModuleDeclaration(declaration);
    });
    shadows.set(symbol, shadowed);
    return !shadowed;
  };
  const member = (node: ts.Node): { receiver: ts.Expression; name?: string } | undefined =>
    ts.isPropertyAccessExpression(node) ? { receiver: node.expression, name: node.name.text }
      : ts.isElementAccessExpression(node) ? { receiver: node.expression,
        name: ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined } : undefined;
  const wrapped = (node: ts.Node): ts.Node => {
    while (node.parent && (ts.isParenthesizedExpression(node.parent) || ts.isAsExpression(node.parent)
      || ts.isTypeAssertionExpression(node.parent) || ts.isSatisfiesExpression(node.parent)
      || ts.isNonNullExpression(node.parent))) { budget.take(); node = node.parent; }
    return node;
  };
  // Walk host and native members iteratively, without nesting proof helpers.
  const safeRead = (node: ts.Node, host: boolean): boolean => {
    for (;;) {
      budget.take();
      const value = wrapped(node), access = member(value.parent);
      if (ts.isTypeOfExpression(value.parent)
        || ts.isBinaryExpression(value.parent) && value.parent.operatorToken.kind === ts.SyntaxKind.InKeyword
          && value.parent.right === value) return true;
      if (!host) {
        if (name === "Request" && ts.isNewExpression(value.parent) && value.parent.expression === value) return true;
        if (name === "Request" && ts.isBinaryExpression(value.parent) && value.parent.right === value
          && value.parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) return true;
        if (name !== "AbortSignal" && ts.isCallExpression(value.parent) && value.parent.expression === value) return true;
        if (!access || access.receiver !== value || !methods[name].includes(access.name ?? "")) return false;
        let callee = value.parent;
        while (callee.parent && (ts.isParenthesizedExpression(callee.parent) || ts.isAsExpression(callee.parent)
          || ts.isTypeAssertionExpression(callee.parent) || ts.isSatisfiesExpression(callee.parent)
          || ts.isNonNullExpression(callee.parent))) { budget.take(); callee = callee.parent; }
        return ts.isTypeOfExpression(callee.parent)
          || ts.isCallExpression(callee.parent) && callee.parent.expression === callee;
      }
      if (!access || access.receiver !== value || access.name === undefined) return false;
      if (access.name === name) { node = value.parent; host = false; continue; }
      if (["__defineGetter__", "__defineSetter__", "__proto__"].includes(access.name)) return false;
      if (!hosts.has(access.name) && !["parent", "top", "frames"].includes(access.name)) return true;
      node = value.parent;
    }
  };
  try {
    const pending: ts.Node[] = [sf];
    let safe = true;
    while (pending.length && safe) {
      budget.take(); const node = pending.pop()!;
      if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) continue;
      if (ts.isIdentifier(node) && (node.text === name || hosts.has(node.text))) {
        if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
          || (ts.isPropertyAssignment(node.parent) || ts.isMethodDeclaration(node.parent)
            || ts.isGetAccessorDeclaration(node.parent) || ts.isSetAccessorDeclaration(node.parent)
            || ts.isPropertyDeclaration(node.parent)) && node.parent.name === node
          || ts.isBindingElement(node.parent) && node.parent.propertyName === node
          || ts.isImportSpecifier(node.parent) && node.parent.propertyName === node
          || ts.isExportSpecifier(node.parent) && node.parent.name === node
          || ts.isNamespaceExport(node.parent)
          || (ts.isLabeledStatement(node.parent) || ts.isBreakStatement(node.parent) || ts.isContinueStatement(node.parent))
            && node.parent.label === node) continue;
        if (unshadowed(node)) safe = safeRead(node, node.text !== name);
      }
      ts.forEachChild(node, child => { pending.push(child); });
    }
    const completed = facts.get(sf) ?? new Map<NativeName, boolean>();
    completed.set(name, safe); facts.set(sf, completed);
    return safe;
  } catch (error) {
    const failed = failures.get(sf) ?? new Map<NativeName, unknown>();
    failed.set(name, error); failures.set(sf, failed);
    throw error;
  }
}
