import { currentImportedBinding, definitionOf, symbolOf } from "../bindings.js";
import ts from "typescript";
import { AnalysisBudget, AnalysisLimitError, projectWorkLimit } from "../analysisBudget.js";
import { conditionNullish, conditionTruth } from "../conditionTruth.js";
import type { FileContext } from "../context.js";
import { isPromiseProducingCall } from "../signals.js";
import { locationOf, sourceSnippetAt, makeFinding } from "./common.js";
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
  const synchronous: SynchronousFacts = { functions: new Map(), values: new Map(), returns: new Map(), results: new Map(), receivers: new Map(), primitives: new Map(), propertyLists: new Map() };
  for (const { rel, sf, ctx } of workspace.units) {
    visit(sf, sf, rel, ctx, contexts, synchronous, out);
  }
  return out;
}

function visit(node: ts.Node, sf: ts.SourceFile, rel: string, ctx: FileContext, contexts: Map<ts.SourceFile, FileContext>, synchronous: SynchronousFacts, out: Finding[]): void {
  if (ts.isCallExpression(node) && isPromiseAll(node)) {
    const arg = node.arguments[0];
    if (arg && ts.isCallExpression(arg) && ts.isPropertyAccessExpression(arg.expression)) {
      const method = arg.expression.name.getText();
      const receiver = arg.expression.expression;
      // A spelling convention is not proof of fixed size: uppercase parameters
      // and database results can still grow with user data.
      const fixedSize = ts.isArrayLiteralExpression(receiver);
      if ((method === "map" || method === "flatMap") && callbackMaySchedule(arg, ctx, contexts, synchronous)
        && !isLimited(arg, ctx, contexts, synchronous) && !fixedSize && isUserSized(receiver, arg)) {
        const { line, column } = locationOf(sf, node);
        out.push(
          makeFinding({
            id: "unbounded-concurrency",
            category: "Concurrency",
            severity: "medium",
            confidence: "medium",
            file: rel,
            line, column,
            message: `Promise.${calleeName(node)} runs one task per item with no concurrency cap.`,
            scaleTrigger: "Large collections fire unbounded parallel work, spiking memory/DB connections and starving the event loop.",
            suggestedFix: "Batch the work (chunking) or cap concurrency with p-limit/Array.from chunks (e.g. 10-50 in flight).",
            snippet: sourceSnippetAt(sf, line),
          }),
        );
      }
    }
  }
  ts.forEachChild(node, (c) => visit(c, sf, rel, ctx, contexts, synchronous, out));
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
function isLimited(call: ts.CallExpression, ctx: FileContext, contexts: Map<ts.SourceFile, FileContext>, synchronous: SynchronousFacts): boolean {
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
  return currentImportedBinding(factory.expression)?.module === "p-limit" && !!factory.arguments[0]
    && ts.isNumericLiteral(factory.arguments[0]) && Number.isSafeInteger(Number(factory.arguments[0].text))
    && Number(factory.arguments[0].text) > 0
    // Arguments run before p-limit receives the deferred function. A fetch in
    // either the task position or an extra argument has already escaped it.
    && !callbackMaySchedule(returned, ctx, contexts, synchronous, true);
}

type InspectableFunction = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration | ts.GetAccessorDeclaration;
type HookMode = "json" | "json-properties" | "values" | "number" | "string";
type VisibleProperty = { value?: ts.Node; getter?: ts.GetAccessorDeclaration };
interface JsonPropertyList { id: number; names: Set<string> }
const TO_PRIMITIVE = Symbol("Symbol.toPrimitive");
const TO_STRING_TAG = Symbol("Symbol.toStringTag");
interface SynchronousFacts {
  functions: Map<ts.Node, Map<number, boolean>>;
  values: Map<ts.Node, Map<string, Map<ts.Node | undefined, boolean>>>;
  returns: Map<InspectableFunction, readonly ts.Expression[]>;
  results: Map<InspectableFunction, Map<string, Map<ts.Node | undefined, boolean>>>;
  receivers: Map<InspectableFunction, boolean>;
  primitives: Map<InspectableFunction, boolean>;
  propertyLists: Map<ts.ArrayLiteralExpression, JsonPropertyList | null>;
}

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
  if (!SYNC_STRING_METHODS.has(method) || writeFacts(call.getSourceFile()).globals.has("String")) return false;
  if (ts.isStringLiteralLike(receiver)) return true;
  const declaration = ts.isIdentifier(receiver) ? symbolOf(receiver)?.valueDeclaration : undefined;
  return !!declaration && ts.isParameter(declaration) && declaration.type?.kind === ts.SyntaxKind.StringKeyword;
}

interface ImmutableValue { value?: ts.Node; depth: number }
interface WriteFacts { bindings: Set<ts.Declaration>; globals: Set<string>; objects: Set<ts.Node>; values: Map<ts.Node, ImmutableValue> }
const sourceWrites = new WeakMap<ts.SourceFile, WriteFacts>();
const BUILTIN_ROOTS = new Set(["JSON", "Math", "Number", "String", "Boolean", "parseInt", "parseFloat", "isNaN", "isFinite", "Date", "Array", "Object", "Symbol"]);
const ARRAY_MUTATIONS = new Set(["copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift"]);

function transparent(node: ts.Node): node is ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression | ts.SatisfiesExpression | ts.TypeAssertion {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
    || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node);
}

/** Resolve immutable captures once; this never evaluates a getter or a call. */
function immutableValue(expression: ts.Node, budget: AnalysisBudget, values: Map<ts.Node, ImmutableValue>): ts.Node | undefined {
  const seen = new Set<ts.Node>();
  let node: ts.Node | undefined = expression;
  let cachedDepth = 0;
  while (node) {
    budget.take();
    if (seen.has(node)) { node = undefined; break; }
    if (seen.size >= 128) throw new AnalysisLimitError("Concurrency value resolution depth limit exceeded");
    const cached = values.get(node);
    if (cached) {
      if (seen.size + cached.depth > 128) throw new AnalysisLimitError("Concurrency value resolution depth limit exceeded");
      cachedDepth = cached.depth; node = cached.value; break;
    }
    seen.add(node);
    if (transparent(node)) { node = node.expression; continue; }
    if (!ts.isIdentifier(node)) break;
    const declaration: ts.Declaration | undefined = symbolOf(node)?.valueDeclaration ?? definitionOf(node);
    if (!declaration && node.text === "undefined") break;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isVariableDeclarationList(declaration.parent)
      || !(declaration.parent.flags & ts.NodeFlags.Const)) { node = undefined; break; }
    node = declaration.initializer;
  }
  let depth = seen.size + cachedDepth;
  for (const input of seen) { budget.take(); values.set(input, { value: node, depth: depth-- }); }
  return node;
}

function writeFacts(sf: ts.SourceFile): WriteFacts {
  let writes = sourceWrites.get(sf);
  if (writes) return writes;
  writes = { bindings: new Set(), globals: new Set(), objects: new Set(), values: new Map() };
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
  const objectIdentity = (expression: ts.Node): ts.Node | undefined => {
    let value = immutableValue(expression, budget, writes!.values);
    while (value && (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value))) {
      budget.take(); value = immutableValue(value.expression, budget, writes!.values);
    }
    if (value?.kind === ts.SyntaxKind.ThisKeyword) {
      for (let parent = value.parent; parent; parent = parent.parent) {
        budget.take();
        if (!ts.isFunctionLike(parent) || ts.isArrowFunction(parent)) continue;
        const owner = ts.isPropertyAssignment(parent.parent) ? parent.parent.parent : parent.parent;
        return ts.isObjectLiteralExpression(owner) ? owner : undefined;
      }
    }
    return value;
  };
  const add = (target: ts.Node): void => {
    budget.take();
    if (ts.isIdentifier(target)) {
      const declaration = symbolOf(target)?.valueDeclaration; if (declaration) writes!.bindings.add(declaration);
      const value = objectIdentity(target); if (value) writes!.objects.add(value);
    } else if (ts.isArrayLiteralExpression(target)) {
      for (const element of target.elements) add(element);
    } else if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isShorthandPropertyAssignment(property)) add(property.name);
        else if (ts.isPropertyAssignment(property)) add(property.initializer);
        else if (ts.isSpreadAssignment(property)) add(property.expression);
      }
    } else if (ts.isSpreadElement(target)) add(target.expression);
    else if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
      let receiver: ts.Node = target.expression;
      while (ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver)) { budget.take(); receiver = receiver.expression; }
      const value = objectIdentity(receiver); if (value) writes!.objects.add(value);
    }
    const root = globalRoot(target); if (root) writes!.globals.add(root);
  };
  const escaped = (expression: ts.Node) => {
    const value = objectIdentity(expression);
    if (value && (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value))) writes!.objects.add(value);
  };
  const captured = (expression: ts.Node) => {
    let value = expression;
    while (transparent(value) || ts.isSpreadElement(value)) { budget.take(); value = value.expression; }
    if (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) escaped(value);
  };
  const readonlyRoot = (callee: ts.Expression): string | undefined => {
    if (ts.isIdentifier(callee) && SYNC_GLOBAL_CALLS.has(callee.text) && !symbolOf(callee)?.declarations?.length) return callee.text;
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const receiver = callee.expression, method = callee.name.text;
    if (unshadowedGlobal(receiver, "JSON") && ["parse", "stringify"].includes(method)) return "JSON";
    if (unshadowedGlobal(receiver, "Object") && SYNC_OBJECT_METHODS.has(method)) return "Object";
    if (unshadowedGlobal(receiver, "Math") && SYNC_MATH_METHODS.has(method)) return "Math";
    if (unshadowedGlobal(receiver, "Date") && ["now", "parse", "UTC"].includes(method)) return "Date";
    if (unshadowedGlobal(receiver, "Array") && method === "isArray") return "Array";
    if (!SYNC_STRING_METHODS.has(method)) return undefined;
    const declaration = ts.isIdentifier(receiver) ? symbolOf(receiver)?.valueDeclaration : undefined;
    return ts.isStringLiteralLike(receiver) || declaration && ts.isParameter(declaration) && declaration.type?.kind === ts.SyntaxKind.StringKeyword ? "String" : undefined;
  };
  const readonlyCalls: Array<{ call: ts.CallExpression; root: string }> = [];
  const pending: ts.Node[] = [sf];
  while (pending.length) {
    budget.take(); const node = pending.pop()!;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      add(node.left);
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) captured(node.right);
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) add(node.operand);
    if (ts.isDeleteExpression(node)) add(node.expression);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && unshadowedGlobal(node.expression.expression, "Object")
      && ["assign", "defineProperty", "defineProperties", "setPrototypeOf"].includes(node.expression.name.text) && node.arguments[0]) {
      const root = globalRoot(node.arguments[0]); if (root) writes.globals.add(root);
      escaped(node.arguments[0]);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        const name = ts.isPropertyAccessExpression(callee) ? callee.name.text
          : ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : undefined;
        if (name === undefined || ARRAY_MUTATIONS.has(name)) {
          const array = immutableValue(callee.expression, budget, writes.values);
          if (array && ts.isArrayLiteralExpression(array)) writes.objects.add(array);
        }
      }
      // Read-only builtins preserve a captured object's shape. Passing it to
      // an unknown callee may install a getter or a serialization hook.
      const read = readonlyRoot(callee);
      if (read) readonlyCalls.push({ call: node, root: read });
      else for (const argument of node.arguments) { budget.take(); escaped(argument); }
    }
    // Mutable captures and objects/arrays expose another path for replacing a
    // hook. Direct const aliases remain inspectable through immutableValue.
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) captured(ts.isPropertyAssignment(node) ? node.initializer : node.name);
    if (ts.isArrayLiteralExpression(node)) for (const element of node.elements) { budget.take(); captured(element); }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isVariableDeclarationList(node.parent)
      && !(node.parent.flags & ts.NodeFlags.Const)) captured(node.initializer);
    ts.forEachChild(node, child => { pending.push(child); });
  }
  // Resolve provisional native calls after the complete mutation scan, so a
  // replaced builtin cannot mutate an argument and leave later hooks trusted.
  for (const { call, root } of readonlyCalls) {
    budget.take();
    if (writes.globals.has(root)) for (const argument of call.arguments) { budget.take(); escaped(argument); }
  }
  sourceWrites.set(sf, writes); return writes;
}

/** Immutable aliases may expose local bodies; mutable bindings stay unknown. */
function localFunction(expression: ts.Node | undefined, budget: AnalysisBudget): InspectableFunction | undefined {
  const seen = new Set<ts.Node>();
  while (expression && !seen.has(expression) && seen.size < 128) {
    budget.take(); seen.add(expression);
    if (transparent(expression)) { expression = expression.expression; continue; }
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression) || ts.isFunctionDeclaration(expression)
      || ts.isMethodDeclaration(expression) || ts.isGetAccessorDeclaration(expression)) return expression;
    if (!ts.isIdentifier(expression)) return undefined;
    const declaration: ts.Declaration | undefined = symbolOf(expression)?.valueDeclaration ?? definitionOf(expression);
    if (declaration && ts.isFunctionDeclaration(declaration)) return writeFacts(declaration.getSourceFile()).bindings.has(declaration) ? undefined : declaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isVariableDeclarationList(declaration.parent)
      || !(declaration.parent.flags & ts.NodeFlags.Const) || writeFacts(declaration.getSourceFile()).bindings.has(declaration)) return undefined;
    expression = declaration.initializer;
  }
  return undefined;
}

/** Scan executed work, including calls whose returned value is discarded.
 * Deferred callbacks are inspected only when a known local callee invokes them;
 * unknown/exterior implementations remain candidates for asynchronous work. */
function callbackMaySchedule(call: ts.CallExpression, ctx: FileContext, contexts: Map<ts.SourceFile, FileContext>, synchronous: SynchronousFacts, argumentsOnly = false): boolean {
  const budget = new AnalysisBudget("Concurrency callback");
  const active = new Set<ts.Node>();
  const jsonPropertyList = (array: ts.ArrayLiteralExpression): JsonPropertyList | undefined => {
    budget.take();
    const known = synchronous.propertyLists.get(array);
    if (known !== undefined) return known ?? undefined;
    const facts = writeFacts(array.getSourceFile());
    const names = new Set<string>();
    let certain = !facts.objects.has(array) && !facts.globals.has("Array");
    for (const element of array.elements) {
      if (!certain) break;
      budget.take();
      const item = immutableValue(element, budget, facts.values);
      if (item && ts.isStringLiteralLike(item)) names.add(item.text);
      else if (item && ts.isNumericLiteral(item)) names.add(String(Number(item.text)));
      else if (!item || ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(item.kind)) certain = false;
    }
    const list = certain ? { names, id: synchronous.propertyLists.size + 1 } : null;
    synchronous.propertyLists.set(array, list);
    return list ?? undefined;
  };
  const inspect = (fn: InspectableFunction, depth: number): boolean => {
    budget.take();
    if (depth > 64 || active.has(fn)) return true;
    if (!fn.asteriskToken && ts.getModifiers(fn)?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) return true;
    const cached = synchronous.functions.get(fn)?.get(depth);
    if (cached !== undefined) return !cached;
    active.add(fn);
    const context = contexts.get(fn.getSourceFile()) ?? ctx;
    // Default parameter and destructuring initializers execute before the body.
    // An unresolved call site cannot prove that a default never runs.
    const schedules = fn.parameters.some(parameter => scan(parameter, context, depth))
      || !fn.asteriskToken && (!fn.body || scan(fn.body, context, depth));
    active.delete(fn);
    const depths = synchronous.functions.get(fn) ?? new Map<number, boolean>();
    depths.set(depth, !schedules); synchronous.functions.set(fn, depths);
    return schedules;
  };
  const returnedValues = (fn: InspectableFunction): readonly ts.Expression[] => {
    budget.take();
    const cached = synchronous.returns.get(fn); if (cached) return cached;
    if (fn.asteriskToken) return []; // Calling a generator returns its iterator.
    const values: ts.Expression[] = [];
    const pending: ts.Node[] = fn.body ? [fn.body] : [];
    if (fn.body && !ts.isBlock(fn.body)) values.push(fn.body);
    else while (pending.length) {
      budget.take(); const node = pending.pop()!;
      if (ts.isFunctionLike(node)) continue;
      if (ts.isReturnStatement(node) && node.expression) values.push(node.expression);
      else ts.forEachChild(node, child => { pending.push(child); });
    }
    synchronous.returns.set(fn, values); return values;
  };
  const nonCallable = (node: ts.Node | undefined): boolean => !!node && (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)
    || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || node.kind === ts.SyntaxKind.NullKeyword
    || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || ts.isVoidExpression(node)
    || ts.isIdentifier(node) && node.text === "undefined" && !symbolOf(node)?.declarations?.length);
  const usesReceiver = (fn: InspectableFunction): boolean => {
    budget.take();
    const cached = synchronous.receivers.get(fn); if (cached !== undefined) return cached;
    const pending: ts.Node[] = fn.body ? [fn.body] : [];
    let uses = false;
    while (pending.length) {
      budget.take(); const node = pending.pop()!;
      if (node.kind === ts.SyntaxKind.ThisKeyword) { uses = true; break; }
      if (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) continue;
      ts.forEachChild(node, child => { pending.push(child); });
    }
    synchronous.receivers.set(fn, uses); return uses;
  };
  const resultHooks = (fn: InspectableFunction, depth: number, mode: HookMode, owner?: ts.Node, list?: JsonPropertyList): boolean => {
    budget.take();
    if (ts.isArrowFunction(fn)) owner = undefined; // Arrow callbacks keep lexical this.
    // The same serializer may be used by many callback sites. Reuse completed
    // result inspection, keeping serialization phase, remaining depth and this
    // receiver separate. A failed traversal never publishes a partial answer.
    const key = `${mode}:${depth}:${list?.id ?? 0}`;
    const receiver = owner && usesReceiver(fn) ? owner : undefined;
    const known = synchronous.results.get(fn)?.get(key)?.get(receiver);
    if (known !== undefined) return known;
    const schedules = returnedValues(fn).some(value => valueHooks(value, mode, depth + 1, receiver, list));
    const modes = synchronous.results.get(fn) ?? new Map<string, Map<ts.Node | undefined, boolean>>();
    const receivers = modes.get(key) ?? new Map<ts.Node | undefined, boolean>();
    receivers.set(receiver, schedules); modes.set(key, receivers); synchronous.results.set(fn, modes);
    return schedules;
  };
  const callableHook = (expression: ts.Node, depth: number, owner?: ts.Node, list?: JsonPropertyList): { schedules: boolean; callable: boolean } => {
    budget.take();
    const fn = localFunction(expression, budget);
    if (fn) return { schedules: inspect(fn, depth + 1) || resultHooks(fn, depth + 1, "json-properties", owner, list), callable: true };
    const value = immutableValue(expression, budget, writeFacts(expression.getSourceFile()).values) ?? expression;
    return { schedules: !nonCallable(value), callable: false };
  };
  const primitiveValue = (expression: ts.Node, depth = 0): boolean => {
    budget.take();
    if (depth > 64) return false;
    const value = immutableValue(expression, budget, writeFacts(expression.getSourceFile()).values) ?? expression;
    if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value) || ts.isBigIntLiteral(value)
      || [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(value.kind)
      || ts.isVoidExpression(value) || ts.isTypeOfExpression(value)
      || ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) return true;
    if (ts.isIdentifier(value) && ["undefined", "NaN", "Infinity"].includes(value.text) && !symbolOf(value)?.declarations?.length) return true;
    if (ts.isConditionalExpression(value)) return primitiveValue(value.whenTrue, depth + 1) && primitiveValue(value.whenFalse, depth + 1);
    if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.CommaToken) return primitiveValue(value.right, depth + 1);
    if (ts.isCallExpression(value) && knownSynchronousBuiltin(value)) {
      if (ts.isIdentifier(value.expression)) return true;
      if (ts.isPropertyAccessExpression(value.expression)) {
        const { expression: receiver, name } = value.expression;
        return unshadowedGlobal(receiver, "Math") || unshadowedGlobal(receiver, "Date")
          || unshadowedGlobal(receiver, "Array") && name.text === "isArray"
          || unshadowedGlobal(receiver, "JSON") && name.text === "stringify"
          || unshadowedGlobal(receiver, "Object") && ["hasOwn", "is", "isExtensible", "isFrozen", "isSealed"].includes(name.text);
      }
    }
    return false;
  };
  const returnsPrimitive = (fn: InspectableFunction): boolean => {
    budget.take();
    const cached = synchronous.primitives.get(fn); if (cached !== undefined) return cached;
    // Falling through also returns undefined, a primitive. Unknown explicit
    // return values cannot prove that ordinary coercion skips its fallback.
    const primitive = returnedValues(fn).every(value => primitiveValue(value));
    synchronous.primitives.set(fn, primitive); return primitive;
  };
  type CoercionOutcome = { schedules: boolean; terminal: boolean };
  const coercionMethod = (expression: ts.Node, exotic: boolean, depth: number): CoercionOutcome => {
    budget.take();
    const fn = localFunction(expression, budget);
    if (fn) return { schedules: inspect(fn, depth + 1), terminal: exotic || returnsPrimitive(fn) };
    const value = immutableValue(expression, budget, writeFacts(expression.getSourceFile()).values) ?? expression;
    const absent = value.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(value)
      || ts.isIdentifier(value) && value.text === "undefined" && !symbolOf(value)?.declarations?.length;
    // Noncallable ordinary methods are skipped. A present noncallable exotic
    // hook throws before either ordinary fallback can run.
    return { schedules: !nonCallable(value), terminal: exotic && !absent && nonCallable(value) };
  };
  const coercionProperty = (property: VisibleProperty, exotic: boolean, depth: number): CoercionOutcome => {
    budget.take();
    if (property.value) return coercionMethod(property.value, exotic, depth);
    if (!property.getter) return { schedules: false, terminal: false };
    if (inspect(property.getter, depth + 1)) return { schedules: true, terminal: false };
    const values = returnedValues(property.getter);
    let terminal = values.length > 0 && property.getter.body?.statements.length === 1
      && ts.isReturnStatement(property.getter.body.statements[0]);
    for (const value of values) {
      const result = coercionMethod(value, exotic, depth + 1);
      if (result.schedules) return result;
      terminal &&= result.terminal;
    }
    return { schedules: false, terminal };
  };
  const coercionObject = (properties: Map<string | symbol, VisibleProperty>, hint: "number" | "string", depth: number): boolean => {
    budget.take();
    const exotic = properties.get(TO_PRIMITIVE);
    if (exotic) {
      const result = coercionProperty(exotic, true, depth);
      if (result.schedules || result.terminal) return result.schedules;
    }
    for (const method of hint === "number" ? ["valueOf", "toString"] : ["toString", "valueOf"]) {
      budget.take();
      const property = properties.get(method);
      if (property) {
        const result = coercionProperty(property, false, depth);
        if (result.schedules || result.terminal) return result.schedules;
      } else if (method === "toString") {
        // Native Object#toString reads the tag getter, but does not invoke or
        // recursively coerce its returned value.
        const tag = properties.get(TO_STRING_TAG);
        return !!tag?.getter && inspect(tag.getter, depth + 1);
      }
    }
    return false;
  };
  const activeValues = new Map<ts.Node, Set<HookMode>>();
  const valueHooks = (expression: ts.Node, mode: HookMode, depth: number, owner?: ts.Node, list?: JsonPropertyList): boolean => {
    budget.take();
    if (depth > 64) return true;
    const facts = writeFacts(expression.getSourceFile());
    const value = immutableValue(expression, budget, facts.values);
    // Keep the established heuristic for unknown input data. Visible hooks
    // require proof; arbitrary runtime objects cannot be enumerated statically.
    if (!value) {
      const declaration = ts.isIdentifier(expression) ? symbolOf(expression)?.valueDeclaration : undefined;
      const initial = declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
        ? immutableValue(declaration.initializer, budget, facts.values) : undefined;
      return !!initial && (ts.isObjectLiteralExpression(initial) || ts.isArrayLiteralExpression(initial));
    }
    if (value.kind === ts.SyntaxKind.ThisKeyword) return !!owner && valueHooks(owner, mode, depth + 1, undefined, list);
    if (ts.isConditionalExpression(value)) {
      const truth = conditionTruth(value.condition, budget);
      return truth !== false && valueHooks(value.whenTrue, mode, depth + 1, owner, list)
        || truth !== true && valueHooks(value.whenFalse, mode, depth + 1, owner, list);
    }
    if (ts.isBinaryExpression(value) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.CommaToken].includes(value.operatorToken.kind)) {
      const op = value.operatorToken.kind;
      if (op === ts.SyntaxKind.CommaToken) return valueHooks(value.right, mode, depth + 1, owner, list);
      const left = immutableValue(value.left, budget, facts.values);
      const object = left && (ts.isObjectLiteralExpression(left) || ts.isArrayLiteralExpression(left) || left.kind === ts.SyntaxKind.ThisKeyword && !!owner);
      const truth = object ? true : conditionTruth(value.left, budget);
      // The left side of && can only be returned when it is falsy, so it
      // cannot supply an object with a serialization hook.
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return truth !== false && valueHooks(value.right, mode, depth + 1, owner, list);
      let takeLeft = truth;
      if (op === ts.SyntaxKind.QuestionQuestionToken) {
        const nullish = object ? false : conditionNullish(value.left, budget);
        takeLeft = nullish === undefined ? undefined : !nullish;
      }
      return takeLeft !== false && valueHooks(value.left, mode, depth + 1, owner, list)
        || takeLeft !== true && valueHooks(value.right, mode, depth + 1, owner, list);
    }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const receiver = immutableValue(value.expression, budget, facts.values);
      return !!receiver && (ts.isObjectLiteralExpression(receiver) || ts.isArrayLiteralExpression(receiver));
    }
    if (!ts.isObjectLiteralExpression(value) && !ts.isArrayLiteralExpression(value)) return false;
    const writes = writeFacts(value.getSourceFile());
    if (writes.objects.has(value) || mode !== "values" && (writes.globals.has("Object")
      || ts.isArrayLiteralExpression(value) && writes.globals.has("Array"))) return true;
    const key = `${mode}:${depth}:${list?.id ?? 0}`;
    const cached = synchronous.values.get(value)?.get(key)?.get(owner); if (cached !== undefined) return cached;
    const states = activeValues.get(value) ?? new Set<HookMode>();
    if (states.has(mode)) return true;
    states.add(mode); activeValues.set(value, states);
    const evaluate = (): boolean => {
      if (ts.isArrayLiteralExpression(value)) {
        return mode !== "values" && value.elements.some(element => {
          budget.take(); return ts.isSpreadElement(element) || valueHooks(element, mode === "number" || mode === "string" ? "string" : "json", depth + 1, owner, list);
        });
      }
      // Preserve final own-property descriptors. A later data property removes
      // an earlier getter; a getter/setter pair retains its getter.
      const properties = new Map<string | symbol, VisibleProperty>();
      for (const property of value.properties) {
        budget.take();
        if (ts.isSpreadAssignment(property)) return true;
        let name: ts.Node = property.name;
        if (ts.isComputedPropertyName(name)) name = immutableValue(name.expression, budget, facts.values) ?? name;
        const symbolName = ts.isPropertyAccessExpression(name) && unshadowedGlobal(name.expression, "Symbol") ? name.name.text
          : ts.isElementAccessExpression(name) && unshadowedGlobal(name.expression, "Symbol") && ts.isStringLiteralLike(name.argumentExpression) ? name.argumentExpression.text : undefined;
        const nativeSymbol = symbolName && !facts.globals.has("Symbol");
        const key = nativeSymbol && symbolName === "toPrimitive" ? TO_PRIMITIVE : nativeSymbol && symbolName === "toStringTag" ? TO_STRING_TAG
          : ts.isIdentifier(name) && !ts.isComputedPropertyName(property.name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? (name as ts.Identifier).text : undefined;
        if (key === undefined) {
          if (mode !== "values" || ts.isGetAccessorDeclaration(property)) return true;
          continue;
        }
        if (key === "__proto__" && ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name)) {
          if (mode !== "values" && property.initializer.kind !== ts.SyntaxKind.NullKeyword) return true;
          continue;
        }
        if (ts.isGetAccessorDeclaration(property)) properties.set(key, { getter: property });
        else if (ts.isSetAccessorDeclaration(property)) properties.set(key, { getter: properties.get(key)?.getter });
        else properties.set(key, { value: ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : property });
      }
      if (mode === "number" || mode === "string") return coercionObject(properties, mode, depth);
      if (mode === "json") {
        const serializer = properties.get("toJSON");
        if (serializer?.value) {
          const hook = callableHook(serializer.value, depth, value, list);
          if (hook.schedules || hook.callable) return hook.schedules;
        } else if (serializer?.getter) {
          if (inspect(serializer.getter, depth + 1)) return true;
          const returns = returnedValues(serializer.getter);
          let alwaysCallable = returns.length > 0 && serializer.getter.body?.statements.length === 1
            && ts.isReturnStatement(serializer.getter.body.statements[0]);
          for (const result of returns) {
            const hook = callableHook(result, depth + 1, value, list);
            if (hook.schedules) return true;
            alwaysCallable &&= hook.callable;
          }
          if (alwaysCallable) return false;
        }
      }
      for (const [key, property] of properties) {
        budget.take();
        if (typeof key === "symbol" || list && !list.names.has(key)) continue;
        if (property.getter && (inspect(property.getter, depth + 1)
          || mode !== "values" && resultHooks(property.getter, depth + 1, "json", value, list))) return true;
        if (mode !== "values" && property.value && valueHooks(property.value, "json", depth + 1, owner, list)) return true;
      }
      return false;
    };
    const schedules = evaluate();
    states.delete(mode);
    const modes = synchronous.values.get(value) ?? new Map<string, Map<ts.Node | undefined, boolean>>();
    const receivers = modes.get(key) ?? new Map<ts.Node | undefined, boolean>();
    receivers.set(owner, schedules); modes.set(key, receivers); synchronous.values.set(value, modes);
    return schedules;
  };
  const coercionArguments = (call: ts.CallExpression, depth: number): boolean => {
    const coercions: Array<[ts.Expression, "number" | "string"]> = [];
    const add = (index: number, hint: "number" | "string") => {
      budget.take(); const argument = call.arguments[index]; if (argument) coercions.push([argument, hint]);
    };
    const expression = call.expression;
    if (ts.isIdentifier(expression)) {
      if (["Number", "isNaN", "isFinite"].includes(expression.text)) add(0, "number");
      if (["String", "parseInt", "parseFloat"].includes(expression.text)) add(0, "string");
      if (expression.text === "parseInt") add(1, "number");
    } else if (ts.isPropertyAccessExpression(expression)) {
      const receiver = expression.expression, method = expression.name.text;
      if (unshadowedGlobal(receiver, "Math")) {
        const count = ["max", "min", "hypot"].includes(method) ? call.arguments.length
          : ["atan2", "imul", "pow"].includes(method) ? 2 : method === "random" ? 0 : 1;
        for (let index = 0; index < count; index++) add(index, "number");
      } else if (unshadowedGlobal(receiver, "Date")) {
        if (method === "parse") add(0, "string");
        if (method === "UTC") for (let index = 0; index < Math.min(7, call.arguments.length); index++) add(index, "number");
      } else if (unshadowedGlobal(receiver, "JSON")) {
        if (method === "parse") add(0, "string");
      } else if (unshadowedGlobal(receiver, "Object")) {
        if (["hasOwn", "getOwnPropertyDescriptor"].includes(method)) add(1, "string");
      } else if (SYNC_STRING_METHODS.has(method)) {
        if (method === "concat") for (let index = 0; index < call.arguments.length; index++) add(index, "string");
        else if (["includes", "startsWith", "endsWith", "indexOf", "lastIndexOf", "split"].includes(method)) { add(0, "string"); add(1, "number"); }
        else if (["slice", "substring"].includes(method)) { add(0, "number"); add(1, "number"); }
        else if (["padStart", "padEnd"].includes(method)) { add(0, "number"); add(1, "string"); }
        else if (["charAt", "charCodeAt", "codePointAt", "at", "repeat"].includes(method)) add(0, "number");
      }
    }
    return coercions.some(([argument, hint]) => valueHooks(argument, hint, depth + 1));
  };
  const scan = (root: ts.Node, context: FileContext, depth: number): boolean => {
    let schedules = false;
    const visit = (node: ts.Node): void => {
      budget.take();
      if (schedules || ts.isFunctionLike(node)) return;
      if (ts.isNewExpression(node) || ts.isAwaitExpression(node) || ts.isTaggedTemplateExpression(node)) { schedules = true; return; }
      if (ts.isCallExpression(node)) {
        if (isPromiseProducingCall(node, context)) { schedules = true; return; }
        if (!knownSynchronousBuiltin(node)) {
          const local = localFunction(node.expression, budget);
          if (!local || inspect(local, depth + 1)) { schedules = true; return; }
        } else if (coercionArguments(node, depth)) { schedules = true; return; }
        else if (ts.isPropertyAccessExpression(node.expression) && unshadowedGlobal(node.expression.expression, "JSON")) {
          const callback = node.arguments[1];
          const replacement = callback && (immutableValue(callback, budget, writeFacts(callback.getSourceFile()).values) ?? callback);
          if (node.expression.name.text === "stringify" && node.arguments[0]) {
            const list = replacement && ts.isArrayLiteralExpression(replacement) ? jsonPropertyList(replacement) : undefined;
            if (valueHooks(node.arguments[0], "json", depth + 1, undefined, list)) { schedules = true; return; }
          }
          // JSON revivers/replacers execute during the synchronous call. Their
          // side effects can launch asynchronous work even when JSON returns sync.
          if (callback && replacement) {
            const local = localFunction(callback, budget);
            if (local ? inspect(local, depth + 1) || node.expression.name.text === "stringify" && resultHooks(local, depth + 1, "json-properties")
              : replacement.kind !== ts.SyntaxKind.NullKeyword && !ts.isVoidExpression(replacement) && !ts.isArrayLiteralExpression(replacement)
                && !(ts.isIdentifier(replacement) && unshadowedGlobal(replacement, "undefined"))) { schedules = true; return; }
          }
        } else if (ts.isPropertyAccessExpression(node.expression) && unshadowedGlobal(node.expression.expression, "Object")
          && ["values", "entries"].includes(node.expression.name.text) && node.arguments[0]
          && valueHooks(node.arguments[0], "values", depth + 1)) {
          schedules = true; return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
    return schedules;
  };
  if (argumentsOnly) return call.arguments.some(argument => scan(argument, ctx, 0));
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
