import ts from "typescript";
import { AnalysisBudget, projectWorkLimit } from "../analysisBudget.js";
import { bindingWriteIndex, symbolOf } from "../bindings.js";
import { staticExpression } from "../staticValues.js";
import { locationOf, sourceSnippetAt, makeFinding, isOrmCall } from "./common.js";
import type { Finding } from "../types.js";
import { Workspace, type SourceUnit } from "../workspace.js";

const LOOP_CALLEE = new Set(["forEach", "map", "flatMap", "filter"]);
const PROMISE_COLLECTIONS = new Set(["all", "allSettled", "any", "race"]);

function outerExpression(node: ts.Node): ts.Node {
  let parent = node.parent;
  while (parent && (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)
    || ts.isNonNullExpression(parent) || ts.isSatisfiesExpression(parent)) && parent.expression === node) {
    node = parent;
    parent = node.parent;
  }
  return node;
}

function isCallback(node: ts.Node | undefined): node is ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction {
  return !!node && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node));
}

export async function detectNPlusOne(root: string, ws?: Workspace): Promise<Finding[]> {
  const workspace = ws ?? (await Workspace.load(root));
  const units = new Map(workspace.units.map(unit => [unit.sf, unit]));
  const budget = new AnalysisBudget("N+1 execution", projectWorkLimit(units.keys()));
  const invoked = new Set<ts.FunctionLikeDeclaration>();
  const iterated = new Map<ts.FunctionLikeDeclaration, boolean>();
  const repeatedCalls = new WeakSet<ts.CallExpression>();
  const callbacks: Array<{ fn: ts.FunctionLikeDeclaration; repeated: boolean; advance: boolean }> = [];
  const consumedArrays = new Map<ts.Node, Map<ts.Node, number>>();
  const pushed: Array<{ node: ts.CallExpression; array: ts.Node; owner: ts.Node }> = [];
  const sites = new Set<ts.CallExpression>();

  const schedule = (expression: ts.Expression | undefined, repeated = true, advance = false) => {
    if (!expression) return;
    const fn = staticExpression(expression, new Set(), budget);
    if (!isCallback(fn) || !fn.body
      || ts.isFunctionDeclaration(fn) && bindingWriteIndex(fn.getSourceFile()).writes.has(fn)) return;
    if (advance) {
      if (!fn.asteriskToken || iterated.get(fn) === true || iterated.has(fn) && !repeated) return;
      iterated.set(fn, repeated);
    } else {
      if (invoked.has(fn)) return;
      invoked.add(fn);
    }
    callbacks.push({ fn, repeated, advance });
  };
  const consumeIterator = (expression: ts.Expression, repeated: boolean, iterator = staticExpression(expression, new Set(), budget)) => {
    if (!iterator || !ts.isCallExpression(iterator)) return;
    // Advancing one captured iterator repeatedly never restarts its body.
    const createdHere = iterator.getSourceFile() === expression.getSourceFile() && iterator.pos >= expression.pos && iterator.end <= expression.end;
    schedule(iterator.expression, repeated && (createdHere || repeatedCalls.has(iterator)), true);
  };
  const walk = (node: ts.Node, unit: SourceUnit, owner: ts.Node, repeated: boolean): void => {
    budget.take();
    if (ts.isFunctionLike(node)) {
      owner = node;
      repeated = false; // Creating a function does not invoke it.
    }
    if (ts.isForOfStatement(node) || ts.isSpreadElement(node) || ts.isYieldExpression(node) && node.asteriskToken && node.expression) {
      consumeIterator(node.expression!, repeated);
    }
    if (ts.isCallExpression(node)) {
      if (repeated) repeatedCalls.add(node);
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        if (method === "next") consumeIterator(callee.expression, repeated);
        if (method === "from" && ts.isIdentifier(callee.expression) && callee.expression.text === "Array"
          && !symbolOf(callee.expression)?.declarations?.length && node.arguments[0]) consumeIterator(node.arguments[0], repeated);
        if (LOOP_CALLEE.has(method)) {
          const implementation = symbolOf(callee.name)?.valueDeclaration;
          if (!implementation || !ts.isMethodDeclaration(implementation) && !ts.isPropertyAssignment(implementation)) schedule(node.arguments[0]);
        }
        if (PROMISE_COLLECTIONS.has(method) && ts.isIdentifier(callee.expression) && callee.expression.text === "Promise"
          && !symbolOf(callee.expression)?.declarations?.length && node.arguments[0]) {
          const array = staticExpression(node.arguments[0], new Set(), budget);
          if (array && ts.isArrayLiteralExpression(array)) {
            const owners = consumedArrays.get(array) ?? new Map<ts.Node, number>();
            owners.set(owner, Math.max(owners.get(owner) ?? 0, node.pos));
            consumedArrays.set(array, owners);
          } else if (array && ts.isCallExpression(array)) consumeIterator(node.arguments[0], repeated, array);
        }
      }
      if (repeated) {
        if (ts.isIdentifier(callee) || !ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) schedule(callee);
        if (isOrmCall(node, unit.ctx)) {
          const value = outerExpression(node);
          const use = value.parent;
          if (ts.isAwaitExpression(use) || ts.isReturnStatement(use) || ts.isYieldExpression(use) || ts.isArrowFunction(use) && use.body === value) sites.add(node);
          else if (ts.isCallExpression(use) && ts.isPropertyAccessExpression(use.expression) && use.expression.name.text === "push"
            && value !== use.expression) {
            const array = staticExpression(use.expression.expression, new Set(), budget);
            if (array && ts.isArrayLiteralExpression(array)) pushed.push({ node, array, owner });
          }
        }
      }
    }
    ts.forEachChild(node, child => {
      if (isCallback(node) && node.asteriskToken && node.body === child
        && !ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) return;
      const perIteration = ts.isIterationStatement(node, false)
        && !(ts.isForStatement(node) && child === node.initializer)
        && !((ts.isForOfStatement(node) || ts.isForInStatement(node)) && child === node.expression);
      walk(child, unit, owner, repeated || perIteration);
    });
  };

  for (const unit of workspace.units) walk(unit.sf, unit, unit.sf, false);
  // Function calls and generator advancement are separate. Each body is
  // revisited at most once for each execution count, including recursive calls.
  for (const { fn, repeated, advance } of callbacks) {
    budget.take();
    const unit = units.get(fn.getSourceFile());
    if (!unit) continue;
    if (!advance) for (const parameter of fn.parameters) walk(parameter, unit, fn, repeated);
    if (fn.body && (!fn.asteriskToken || advance)) walk(fn.body, unit, fn, repeated);
  }
  for (const { node, array, owner } of pushed) {
    budget.take();
    if ((consumedArrays.get(array)?.get(owner) ?? -1) > node.pos) sites.add(node);
  }
  // A named callback may be discovered after its declaration or in another
  // file. Preserve source order for findings that share a severity.
  const out = Array.from(sites, node => {
    const unit = units.get(node.getSourceFile())!;
    const location = locationOf(unit.sf, node);
    return makeFinding({ id: "n-plus-one", category: "DB", severity: "high", confidence: "medium",
      file: unit.rel, ...location, message: "ORM/database call repeated inside a loop or collection callback; this is an N+1 pattern.",
      scaleTrigger: "One database round-trip per item grows with collection size, even when executed concurrently.",
      suggestedFix: "Batch queries with an IN filter or join instead of one read per item.", snippet: sourceSnippetAt(unit.sf, location.line) });
  });
  return out.sort((a, b) => {
    budget.take();
    return a.file.localeCompare(b.file) || a.line - b.line || a.column! - b.column!;
  });
}
