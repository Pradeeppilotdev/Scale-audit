import ts from "typescript";
import { currentInitializer, definitionOf, symbolOf } from "./bindings.js";
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
      // Preserve a local alias's own capture time instead of letting the
      // general binding resolver skip directly to its original initializer.
      const direct = symbolOf(current)?.valueDeclaration;
      const declaration = direct && ts.isVariableDeclaration(direct) ? direct : definitionOf(current);
      if (declaration && ts.isVariableDeclaration(declaration)) {
        current = currentInitializer(declaration, current) ?? unknownStaticValue();
        continue;
      }
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

type StaticTruth = boolean | undefined;
interface ReturnPath {
  result?: ts.Expression[];
  branch?: { condition: ts.Expression; outcomes: Map<StaticTruth, ReturnPath> };
}
interface FactoryIndex {
  methods: WeakMap<ts.ClassLikeDeclaration, Map<string, ts.MethodDeclaration>>;
  facts: WeakMap<ts.MethodDeclaration, { parameters: Map<ts.Declaration, number>; path: ReturnPath }>;
}
const factoryIndexes = new WeakMap<AnalysisBudget, FactoryIndex>();
class StaticReturnBudget extends AnalysisBudget {
  constructor(private readonly projectBudget?: AnalysisBudget) { super("Static module returns"); }
  override take(count = 1): void {
    this.projectBudget?.take(count);
    super.take(count);
  }
}

/** Resolve a local static module method's literal returns without invoking it. */
export function staticReturns(call: ts.CallExpression, shared?: AnalysisBudget): ts.Expression[] {
  if (!ts.isPropertyAccessExpression(call.expression)) return [];
  const owner = definitionOf(call.expression.expression);
  if (!owner || (!ts.isClassDeclaration(owner) && !ts.isClassExpression(owner))) return [];
  const budget = new StaticReturnBudget(shared), lookupBudget = shared ?? budget;
  lookupBudget.take();
  let index = factoryIndexes.get(lookupBudget);
  if (!index) {
    index = { methods: new WeakMap(), facts: new WeakMap() };
    factoryIndexes.set(lookupBudget, index);
  }
  let methods = index.methods.get(owner);
  if (!methods) {
    methods = new Map();
    for (const member of owner.members) {
      lookupBudget.take();
      if (ts.isMethodDeclaration(member) && member.body
        && (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name))
        && ts.getModifiers(member)?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)) methods.set(member.name.text, member);
    }
    index.methods.set(owner, methods);
  }
  const method = methods.get(call.expression.name.text);
  if (!method?.body) return [];
  let facts = index.facts.get(method);
  if (!facts) {
    const parameters = new Map<ts.Declaration, number>();
    for (let i = 0; i < method.parameters.length; i++) { lookupBudget.take(); parameters.set(method.parameters[i], i); }
    facts = { parameters, path: {} };
    index.facts.set(method, facts);
  }
  const { parameters, path } = facts;
  if (path.result) return path.result;
  let readParameter = false;
  const truth = (node: ts.Expression, depth = 0): boolean | undefined => {
    budget.take(); if (depth > 64) throw new AnalysisLimitError("Static condition recursion limit exceeded");
    const definition = definitionOf(node);
    const parameter = definition && parameters.get(definition);
    if (parameter !== undefined) {
      readParameter = true;
      const argument = call.arguments[parameter] ?? method.parameters[parameter].initializer;
      if (argument) return truth(argument, depth + 1);
    }
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
  // Branches are the only part of the return walk that uses call arguments.
  // Re-evaluate each observed condition with this call's arguments and depth
  // checks. An unconditional result needs no body or argument traversal.
  const conditions = new Map<ts.Expression, { value: StaticTruth; argumentDependent: boolean }>();
  const decision = (condition: ts.Expression) => {
    const cached = conditions.get(condition); if (cached) return cached;
    readParameter = false;
    const value = truth(condition);
    const observed = { value, argumentDependent: readParameter };
    conditions.set(condition, observed);
    return observed;
  };
  let known = path;
  while (known.branch) {
    budget.take();
    const next = known.branch.outcomes.get(decision(known.branch.condition).value);
    if (!next) break;
    known = next;
  }
  if (known.result) return known.result;
  const trace: { condition: ts.Expression; value: StaticTruth }[] = [];
  const branch = (condition: ts.Expression): StaticTruth => {
    const { value, argumentDependent } = decision(condition);
    if (argumentDependent) trace.push({ condition, value });
    return value;
  };
  const result: ts.Expression[] = [];
  const returned = (expression: ts.Expression, depth = 0) => {
    budget.take(); if (depth > 64) throw new AnalysisLimitError("Static return recursion limit exceeded");
    const value = staticExpression(expression, new Set(), budget);
    if (value && ts.isConditionalExpression(value)) {
      const condition = branch(value.condition);
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
      const condition = branch(node.expression);
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
  // Publish a completed path only after all local and project work checks.
  budget.take(trace.length);
  let leaf = path;
  for (const { condition, value } of trace) {
    const { outcomes } = leaf.branch ??= { condition, outcomes: new Map<StaticTruth, ReturnPath>() };
    let next = outcomes.get(value);
    if (!next) { next = {}; outcomes.set(value, next); }
    leaf = next;
  }
  leaf.result = result;
  return result;
}
