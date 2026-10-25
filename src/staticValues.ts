import ts from "typescript";
import { definitionOf } from "./bindings.js";
import { AnalysisBudget, AnalysisLimitError } from "./analysisBudget.js";

export type StaticToken = string | ts.Node;

/** Bounded AST normalization. Never runs a target function, getter or module. */
export function staticExpression(node: ts.Node | undefined, seen = new Set<ts.Node>(), budget = new AnalysisBudget("Static expression")): ts.Node | undefined {
  const visited = new Set(seen);
  let current = node;
  while (current) {
    budget.take();
    if (visited.has(current)) return unknownStaticValue();
    if (visited.size >= 256) throw new AnalysisLimitError("Static expression recursion limit exceeded");
    visited.add(current);
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current) || ts.isAwaitExpression(current) || ts.isTypeAssertionExpression(current)) { current = current.expression; continue; }
    if (ts.isIdentifier(current) || ts.isPropertyAccessExpression(current)) {
      const declaration = definitionOf(current);
      if (declaration && ts.isVariableDeclaration(declaration)) { current = declaration.initializer; continue; }
      if (declaration && (ts.isIdentifier(current) || ts.isClassDeclaration(declaration) || ts.isFunctionDeclaration(declaration))) return declaration;
    }
    return current;
  }
  return undefined;
}

/** Literal aliases compare by value; class and Symbol tokens retain declaration identity. */
export function staticToken(node: ts.Node): StaticToken {
  const value = staticExpression(node);
  if (value && (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value))) return `${ts.isNumericLiteral(value) ? "number" : "string"}:${value.text}`;
  return definitionOf(node) ?? value ?? node;
}

export function staticProperty(object: ts.Node | undefined, name: string, budget = new AnalysisBudget("Static metadata")): ts.Node | undefined {
  const properties = staticProperties(object, budget);
  return properties.get(name) ?? properties.get("*");
}

/** Effective properties in JavaScript spread/override order, including method factories. */
export function staticProperties(object: ts.Node | undefined, budget = new AnalysisBudget("Static metadata"), seen = new Set<ts.Node>()): Map<string, ts.Node> {
  budget.take();
  const resolved = staticExpression(object, new Set(), budget);
  const result = new Map<string, ts.Node>();
  if (!resolved || !ts.isObjectLiteralExpression(resolved)) return result;
  if (seen.has(resolved) || seen.size > 64) throw new AnalysisLimitError("Static metadata recursion limit exceeded");
  const next = new Set(seen).add(resolved);
  const invalidate = () => { budget.take(result.size); result.clear(); result.set("*", unknownStaticValue()); };
  for (const property of resolved.properties) {
    budget.take();
    if (ts.isSpreadAssignment(property)) {
      const spread = staticExpression(property.expression, new Set(), budget);
      if (!spread || !ts.isObjectLiteralExpression(spread)) invalidate();
      else for (const [key, value] of staticProperties(spread, budget, next)) {
        budget.take();
        if (key === "*") invalidate(); else { result.delete(key); result.set(key, value); }
      }
    } else if (property.name && ts.isComputedPropertyName(property.name)) invalidate();
    else if (ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
      const name = property.name;
      if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) result.set(name.text, unknownStaticValue());
    }
    else if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
      const name = property.name;
      const key = ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined;
      if (key !== undefined) result.set(key, ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : property);
    }
  }
  // Unknown spreads can introduce any option that was not explicitly restored.
  return result;
}
export function isUnknownStaticValue(node: ts.Node): boolean { return ts.isIdentifier(node) && node.pos < 0 && node.text === "unresolvedStaticOption"; }
function unknownStaticValue(): ts.Identifier { return ts.factory.createIdentifier("unresolvedStaticOption"); }

export function staticArray(node: ts.Node | undefined, seen = new Set<ts.Node>(), budget = new AnalysisBudget("Static array")): ts.Expression[] {
  budget.take();
  const resolved = staticExpression(node, new Set(), budget);
  if (!resolved || !ts.isArrayLiteralExpression(resolved)) return node ? [unknownStaticValue()] : [];
  if (seen.has(resolved) || seen.size > 64) throw new AnalysisLimitError("Static array recursion limit exceeded");
  const next = new Set(seen).add(resolved);
  const result: ts.Expression[] = [];
  for (const element of resolved.elements) {
    budget.take();
    if (ts.isSpreadElement(element)) {
      for (const nested of staticArray(element.expression, next, budget)) { budget.take(); result.push(nested); }
    } else if (ts.isExpression(element)) result.push(element);
  }
  return result;
}

/** Resolve a local static module method's literal returns without invoking it. */
export function staticReturns(call: ts.CallExpression): ts.Expression[] {
  if (!ts.isPropertyAccessExpression(call.expression)) return [];
  const owner = definitionOf(call.expression.expression);
  if (!owner || (!ts.isClassDeclaration(owner) && !ts.isClassExpression(owner))) return [];
  const methodName = call.expression.name.text;
  const method = owner.members.find(member => ts.isMethodDeclaration(member) && member.name.getText() === methodName
    && ts.getModifiers(member)?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword));
  if (!method || !ts.isMethodDeclaration(method) || !method.body) return [];
  const budget = new AnalysisBudget("Static module returns");
  const argumentsByParameter = new Map<ts.Node, ts.Expression>();
  for (let i = 0; i < method.parameters.length; i++) {
    const argument = call.arguments[i] ?? method.parameters[i].initializer;
    if (argument) argumentsByParameter.set(method.parameters[i], argument);
  }
  const truth = (node: ts.Expression, depth = 0): boolean | undefined => {
    budget.take(); if (depth > 64) throw new AnalysisLimitError("Static condition recursion limit exceeded");
    const definition = definitionOf(node);
    const argument = definition && argumentsByParameter.get(definition);
    if (argument) return truth(argument, depth + 1);
    const value = staticExpression(node, new Set(), budget);
    if (!value) return undefined;
    if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (value.kind === ts.SyntaxKind.FalseKeyword || value.kind === ts.SyntaxKind.NullKeyword) return false;
    if (ts.isNumericLiteral(value)) return Number(value.text) !== 0;
    if (ts.isStringLiteralLike(value)) return value.text.length > 0;
    if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) {
      const inner = truth(value.operand, depth + 1); return inner === undefined ? undefined : !inner;
    }
    return undefined;
  };
  const result: ts.Expression[] = [];
  const returned = (expression: ts.Expression, depth = 0) => {
    budget.take(); if (depth > 64) throw new AnalysisLimitError("Static return recursion limit exceeded");
    const value = staticExpression(expression, new Set(), budget);
    if (value && ts.isConditionalExpression(value)) {
      const condition = truth(value.condition);
      if (condition !== false) returned(value.whenTrue, depth + 1);
      if (condition !== true) returned(value.whenFalse, depth + 1);
    } else result.push(expression);
  };
  const collect = (node: ts.Node, depth = 0): boolean => {
    budget.take(); if (depth > 64) throw new AnalysisLimitError("Static return recursion limit exceeded");
    if (ts.isFunctionLike(node)) return false;
    if (ts.isReturnStatement(node) && node.expression) { returned(node.expression); return true; }
    if (ts.isBlock(node)) { for (const statement of node.statements) if (collect(statement, depth + 1)) return true; return false; }
    if (ts.isIfStatement(node)) {
      const condition = truth(node.expression);
      if (condition === true) return collect(node.thenStatement, depth + 1);
      if (condition === false) return !!node.elseStatement && collect(node.elseStatement, depth + 1);
      const thenReturns = collect(node.thenStatement, depth + 1);
      const elseReturns = !!node.elseStatement && collect(node.elseStatement, depth + 1);
      return thenReturns && elseReturns;
    }
    // Loops/try/switch may return, but do not prove that subsequent statements are unreachable.
    ts.forEachChild(node, child => { collect(child, depth + 1); });
    return false;
  };
  collect(method.body);
  return result;
}
