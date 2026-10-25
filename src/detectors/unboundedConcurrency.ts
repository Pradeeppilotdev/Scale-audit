import { definitionOf, importedBinding, symbolOf } from "../bindings.js";
import ts from "typescript";
import { AnalysisBudget, projectWorkLimit } from "../analysisBudget.js";
import type { FileContext } from "../context.js";
import { isPromiseProducingCall } from "../signals.js";
import { lineOf, snippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";
import { Workspace } from "../workspace.js";

const ALL_METHODS = new Set(["all", "allSettled"]);

/**
 * Property names that usually hold a user-sized collection.
 * `rows`, `items`, `users` etc. are the classic shapes.
 */
const COLLECTION_PROPERTIES = new Set([
  "items",
  "rows",
  "records",
  "results",
  "entries",
  "elements",
  "list",
  "users",
  "posts",
  "orders",
  "products",
  "customers",
  "messages",
  "events",
  "jobs",
  "tasks",
  "files",
  "children",
  "data",
]);

export async function detectUnboundedConcurrency(root: string, ws?: Workspace): Promise<Finding[]> {
  const out: Finding[] = [];
  const workspace = ws ?? (await Workspace.load(root));
  const contexts = new Map(workspace.units.map(unit => [unit.sf, unit.ctx]));
  const synchronous = new Map<ts.Node, boolean>();
  for (const { rel, content, sf, ctx } of workspace.units) {
    visit(sf, sf, content, rel, ctx, contexts, synchronous, out);
  }
  return out;
}

function visit(node: ts.Node, sf: ts.SourceFile, content: string, rel: string, ctx: FileContext, contexts: Map<ts.SourceFile, FileContext>, synchronous: Map<ts.Node, boolean>, out: Finding[]): void {
  if (ts.isCallExpression(node) && isPromiseAll(node)) {
    const arg = node.arguments[0];
    if (arg && ts.isCallExpression(arg) && ts.isPropertyAccessExpression(arg.expression)) {
      const method = arg.expression.name.getText();
      const receiver = arg.expression.expression;
      // A spelling convention is not proof of fixed size: uppercase parameters
      // and database results can still grow with user data.
      const fixedSize = ts.isArrayLiteralExpression(receiver);
      if ((method === "map" || method === "flatMap") && callbackMaySchedule(arg, ctx, contexts, synchronous) && !isLimited(arg) && !fixedSize && isUserSized(receiver, arg)) {
        const ln = lineOf(sf, node);
        out.push(
          makeFinding({
            id: "unbounded-concurrency",
            category: "Concurrency",
            severity: "medium",
            confidence: "medium",
            file: rel,
            line: ln,
            message: `Promise.${calleeName(node)} runs one task per item with no concurrency cap.`,
            scaleTrigger: "Large collections fire unbounded parallel work, spiking memory/DB connections and starving the event loop.",
            suggestedFix: "Batch the work (chunking) or cap concurrency with p-limit/Array.from chunks (e.g. 10-50 in flight).",
            snippet: snippetAt(content, ln),
          }),
        );
      }
    }
  }
  ts.forEachChild(node, (c) => visit(c, sf, content, rel, ctx, contexts, synchronous, out));
}

function isPromiseAll(node: ts.CallExpression): boolean {
  const expr = node.expression;
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "Promise" && !symbolOf(expr.expression)?.declarations?.length &&
    ALL_METHODS.has(expr.name.getText())
  );
}

function calleeName(node: ts.CallExpression): string {
  return ts.isPropertyAccessExpression(node.expression) ? node.expression.name.getText() : "all";
}

/** Heuristic: already wrapped in a limiter/chunk helper. */
function isLimited(call: ts.CallExpression): boolean {
  const callback = call.arguments[0];
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return false;
  let returned: ts.Expression | undefined;
  if (ts.isBlock(callback.body)) {
    if (callback.body.statements.length !== 1 || !ts.isReturnStatement(callback.body.statements[0])) return false;
    returned = callback.body.statements[0].expression;
  } else returned = callback.body;
  if (returned && ts.isAwaitExpression(returned)) returned = returned.expression;
  if (!returned || !ts.isCallExpression(returned) || !ts.isIdentifier(returned.expression)) return false;
  // Follow immutable aliases only: a reassigned let cannot prove a limiter.
  let factory: ts.Node | undefined = returned.expression;
  const seen = new Set<ts.Node>();
  while (factory && !seen.has(factory) && seen.size < 128) {
    seen.add(factory);
    if (ts.isParenthesizedExpression(factory) || ts.isAsExpression(factory) || ts.isNonNullExpression(factory)) { factory = factory.expression; continue; }
    if (!ts.isIdentifier(factory)) break;
    const declaration: ts.Declaration | undefined = symbolOf(factory)?.valueDeclaration ?? definitionOf(factory);
    if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isVariableDeclarationList(declaration.parent)
      || !(declaration.parent.flags & ts.NodeFlags.Const)) return false;
    factory = declaration.initializer;
  }
  if (!factory || !ts.isCallExpression(factory)) return false;
  return importedBinding(factory.expression)?.module === "p-limit" && !!factory.arguments[0]
    && ts.isNumericLiteral(factory.arguments[0]) && Number(factory.arguments[0].text) > 0;
}

type InspectableFunction = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

// Property method names are not evidence for unknown objects: x.toString()
// remains conservatively noisy because target code may override the method.
const SYNC_GLOBAL_CALLS = new Set(["Number", "String", "Boolean", "parseInt", "parseFloat", "isNaN", "isFinite"]);
const SYNC_MATH_METHODS = new Set(["abs", "acos", "acosh", "asin", "asinh", "atan", "atanh", "atan2", "ceil", "cbrt", "expm1", "clz32", "cos", "cosh", "exp", "floor", "fround", "hypot", "imul", "log", "log1p", "log2", "log10", "max", "min", "pow", "random", "round", "sign", "sin", "sinh", "sqrt", "tan", "tanh", "trunc"]);
const SYNC_OBJECT_METHODS = new Set(["keys", "values", "entries", "getOwnPropertyNames", "getOwnPropertySymbols", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "getPrototypeOf", "hasOwn", "is", "isExtensible", "isFrozen", "isSealed"]);
const SYNC_STRING_METHODS = new Set(["trim", "trimStart", "trimEnd", "toLowerCase", "toUpperCase", "charAt", "charCodeAt", "codePointAt", "includes", "startsWith", "endsWith", "indexOf", "lastIndexOf", "slice", "substring", "split", "concat", "repeat", "padStart", "padEnd", "at"]);

function unshadowedGlobal(node: ts.Node, name: string): boolean {
  return ts.isIdentifier(node) && node.text === name && !symbolOf(node)?.declarations?.length;
}

function knownSynchronousBuiltin(call: ts.CallExpression): boolean {
  const expression = call.expression;
  const global = ts.isIdentifier(expression) ? expression : ts.isPropertyAccessExpression(expression) ? expression.expression : undefined;
  if (global && ts.isIdentifier(global) && writeFacts(call.getSourceFile()).globals.has(global.text)) return false;
  if (ts.isIdentifier(expression)) return SYNC_GLOBAL_CALLS.has(expression.text) && !symbolOf(expression)?.declarations?.length;
  if (!ts.isPropertyAccessExpression(expression)) return false;
  const receiver = expression.expression, method = expression.name.text;
  if (unshadowedGlobal(receiver, "JSON")) return method === "parse" || method === "stringify";
  if (unshadowedGlobal(receiver, "Math")) return SYNC_MATH_METHODS.has(method);
  if (unshadowedGlobal(receiver, "Date")) return method === "now" || method === "parse" || method === "UTC";
  if (unshadowedGlobal(receiver, "Array")) return method === "isArray";
  if (unshadowedGlobal(receiver, "Object")) return SYNC_OBJECT_METHODS.has(method);
  // A primitive annotation/literal establishes receiver semantics without
  // treating an arbitrary object's identically named method as synchronous.
  if (!SYNC_STRING_METHODS.has(method)) return false;
  if (ts.isStringLiteralLike(receiver)) return true;
  const declaration = ts.isIdentifier(receiver) ? symbolOf(receiver)?.valueDeclaration : undefined;
  return !!declaration && ts.isParameter(declaration) && declaration.type?.kind === ts.SyntaxKind.StringKeyword;
}

interface WriteFacts { bindings: Set<ts.Declaration>; globals: Set<string> }
const sourceWrites = new WeakMap<ts.SourceFile, WriteFacts>();
const BUILTIN_ROOTS = new Set(["JSON", "Math", "Number", "String", "Boolean", "parseInt", "parseFloat", "isNaN", "isFinite", "Date", "Array", "Object"]);
function writeFacts(sf: ts.SourceFile): WriteFacts {
  let writes = sourceWrites.get(sf);
  if (writes) return writes;
  writes = { bindings: new Set(), globals: new Set() };
  const budget = new AnalysisBudget("Concurrency binding writes", projectWorkLimit([sf]));
  const globalRoot = (target: ts.Node): string | undefined => {
    let property: string | undefined;
    while (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
      property = ts.isPropertyAccessExpression(target) ? target.name.text : target.argumentExpression && ts.isStringLiteralLike(target.argumentExpression) ? target.argumentExpression.text : undefined;
      target = target.expression;
    }
    if (!ts.isIdentifier(target) || symbolOf(target)?.declarations?.length) return undefined;
    const name = target.text === "globalThis" ? property : target.text;
    return name && BUILTIN_ROOTS.has(name) ? name : undefined;
  };
  const add = (target: ts.Node): void => {
    budget.take();
    if (ts.isIdentifier(target)) {
      const declaration = symbolOf(target)?.valueDeclaration; if (declaration) writes!.bindings.add(declaration);
    } else if (ts.isArrayLiteralExpression(target)) {
      for (const element of target.elements) add(element);
    } else if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isShorthandPropertyAssignment(property)) add(property.name);
        else if (ts.isPropertyAssignment(property)) add(property.initializer);
        else if (ts.isSpreadAssignment(property)) add(property.expression);
      }
    } else if (ts.isSpreadElement(target)) add(target.expression);
    const root = globalRoot(target); if (root) writes!.globals.add(root);
  };
  const pending: ts.Node[] = [sf];
  while (pending.length) {
    budget.take(); const node = pending.pop()!;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) add(node.left);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) add(node.operand);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && unshadowedGlobal(node.expression.expression, "Object")
      && ["assign", "defineProperty", "defineProperties", "setPrototypeOf"].includes(node.expression.name.text) && node.arguments[0]) {
      const root = globalRoot(node.arguments[0]); if (root) writes.globals.add(root);
    }
    ts.forEachChild(node, child => { pending.push(child); });
  }
  sourceWrites.set(sf, writes); return writes;
}

/** Immutable aliases may expose local bodies; mutable bindings stay unknown. */
function localFunction(expression: ts.Node | undefined, budget: AnalysisBudget): InspectableFunction | undefined {
  const seen = new Set<ts.Node>();
  while (expression && !seen.has(expression) && seen.size < 128) {
    budget.take(); seen.add(expression);
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) { expression = expression.expression; continue; }
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression) || ts.isFunctionDeclaration(expression)) return expression;
    if (!ts.isIdentifier(expression)) return undefined;
    const declaration: ts.Declaration | undefined = symbolOf(expression)?.valueDeclaration ?? definitionOf(expression);
    if (declaration && ts.isFunctionDeclaration(declaration)) return writeFacts(declaration.getSourceFile()).bindings.has(declaration) ? undefined : declaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isVariableDeclarationList(declaration.parent)
      || !(declaration.parent.flags & ts.NodeFlags.Const)) return undefined;
    expression = declaration.initializer;
  }
  return undefined;
}

/** Scan executed work, including calls whose returned value is discarded.
 * Deferred callbacks are inspected only when a known local callee invokes them;
 * unknown/exterior implementations remain candidates for asynchronous work. */
function callbackMaySchedule(call: ts.CallExpression, ctx: FileContext, contexts: Map<ts.SourceFile, FileContext>, synchronous: Map<ts.Node, boolean>): boolean {
  const budget = new AnalysisBudget("Concurrency callback");
  const active = new Set<ts.Node>();
  const inspect = (fn: InspectableFunction, depth: number): boolean => {
    budget.take();
    if (depth > 64 || active.has(fn)) return true;
    if (ts.getModifiers(fn)?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) return true;
    const cached = synchronous.get(fn);
    if (cached !== undefined) return !cached;
    active.add(fn);
    let schedules = false;
    const context = contexts.get(fn.getSourceFile()) ?? ctx;
    const visit = (node: ts.Node): void => {
      budget.take();
      if (schedules || ts.isFunctionLike(node)) return;
      if (ts.isNewExpression(node) || ts.isAwaitExpression(node) || ts.isTaggedTemplateExpression(node)) { schedules = true; return; }
      if (ts.isCallExpression(node)) {
        if (isPromiseProducingCall(node, context)) { schedules = true; return; }
        if (!knownSynchronousBuiltin(node)) {
          const local = localFunction(node.expression, budget);
          if (!local || inspect(local, depth + 1)) { schedules = true; return; }
        } else if (ts.isPropertyAccessExpression(node.expression) && unshadowedGlobal(node.expression.expression, "JSON") && node.arguments[1]) {
          // JSON revivers/replacers execute during the synchronous call. Their
          // side effects can launch asynchronous work even when JSON returns sync.
          const callback = node.arguments[1];
          const local = localFunction(callback, budget);
          if (local ? inspect(local, depth + 1) : callback.kind !== ts.SyntaxKind.NullKeyword && !ts.isArrayLiteralExpression(callback)) { schedules = true; return; }
        }
      }
      ts.forEachChild(node, visit);
    };
    // Default parameter and destructuring initializers execute before the body.
    // Arguments may bypass a default, but an unresolved call site cannot prove
    // that the default never runs, so preserve its possible asynchronous work.
    for (const parameter of fn.parameters) visit(parameter);
    if (!fn.body) schedules = true;
    else visit(fn.body);
    active.delete(fn);
    synchronous.set(fn, !schedules);
    return schedules;
  };
  const callback = localFunction(call.arguments[0], budget);
  return !callback || inspect(callback, 0);
}

/**
 * Is the mapped collection plausibly user-sized?
 *
 * `Promise.all(xs.map(...))` is only a scaling problem when `xs` can grow.
 * A local array of render callbacks is not. We require positive evidence:
 * the collection comes from a database read, it is a function parameter, or it
 * is a property with a collection-ish name.
 *
 * Scopes are respected: only *enclosing* parameters and declarations count, so
 * an unrelated `callbacks` parameter elsewhere in the file does not count.
 */
function isUserSized(receiver: ts.Expression, node: ts.Node, seen = new Set<ts.Node>()): boolean {
  if (seen.has(receiver) || seen.size > 128) return false;
  seen.add(receiver);
  if (ts.isAwaitExpression(receiver) || ts.isParenthesizedExpression(receiver)) return isUserSized(receiver.expression, node, seen);
  // `await db.findMany()` / `db.findAll()`
  if (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)) {
    const method = receiver.expression.name.getText();
    if (method === "findMany" || method === "findAll" || method === "find") return true;
  }
  // `res.rows`, `page.items`
  if (ts.isPropertyAccessExpression(receiver)) {
    const name = receiver.name.getText();
    if (COLLECTION_PROPERTIES.has(name)) return true;
    // `res.data.items`
    if (ts.isPropertyAccessExpression(receiver.expression)) {
      const outer = receiver.expression.name.getText();
      if (COLLECTION_PROPERTIES.has(outer)) return true;
    }
  }
  // A function parameter: the size is controlled by the caller.
  if (ts.isIdentifier(receiver) && symbolOf(receiver)?.declarations?.some(ts.isParameter)) return true;
  // A local bound directly from one of the above.
  if (ts.isIdentifier(receiver)) {
    const declaration = symbolOf(receiver)?.valueDeclaration;
    const init = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
    if (init) {
      // `const queue: string[] = []` starts empty and is filled at runtime, so
      // its size is unbounded. A non-empty literal is a fixed-size constant.
      if (ts.isArrayLiteralExpression(init) && init.elements.length === 0) return true;
      return isUserSized(init, node, seen);
    }
  }
  return false;
}
