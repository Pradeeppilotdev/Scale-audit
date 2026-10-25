import { AnalysisBudget, projectWorkLimit } from "./analysisBudget.js";
import { definitionOf, isHttpFetch, symbolOf } from "./bindings.js";
import ts from "typescript";
import type { FileContext } from "./context.js";
import { DB_WRITE_RECEIVER } from "./detectors/common.js";
import { isKnownModel } from "./detectors/common.js";

/**
 * Method names that mutate data. A call to one of these that is never awaited
 * is a floating promise: the write may never complete, and a rejection becomes
 * an unhandled rejection.
 */
export const DB_WRITE_METHODS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "insert",
  "insertMany",
  "save",
  "remove",
  "destroy",
  "publish",
  "incr",
  "decr",
  "sadd",
  "hset",
  "zadd",
  "rpush",
  "lpush",
  "setex",
]);

/** Calls that return a promise and are commonly left unawaited. */
export const PROMISE_CALL_NAMES = new Set([...DB_WRITE_METHODS, "fetch"]);

/**
 * True when the call is a database write we are confident about.
 *
 * This used to accept any `something.create()` in a file that happened to
 * import an ORM, which flagged every `headers.set()` and `stream.write()` in
 * the world. Now the receiver has to be a database-ish client or a model we
 * have evidence for.
 */
export function isDbWriteCall(node: ts.CallExpression, ctx?: FileContext): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const method = node.expression.name.getText();
  if (!DB_WRITE_METHODS.has(method)) return false;
  const receiver = node.expression.expression.getText();
  if (DB_WRITE_RECEIVER.test(receiver)) return true;
  if (ctx && isKnownModel(receiver, ctx)) return true;
  return false;
}

/** True when the call expression is known to return a promise. */
export function isPromiseProducingCall(node: ts.CallExpression, ctx?: FileContext): boolean {
  if (isHttpFetch(node.expression) || asyncCallable(node.expression)) return true;
  if (ts.isIdentifier(node.expression)) {
    // `fetch` always returns a promise.
    return isHttpFetch(node.expression);
  }
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const method = node.expression.name.getText();
  if (method === "then" || method === "catch" || method === "finally") return false;
  if (method === "fetch") return isHttpFetch(node.expression);
  if (PROMISE_CALL_NAMES.has(method)) return isDbWriteCall(node, ctx);
  return false;
}

/**
 * A call is "floating" when it is an expression statement whose value is a
 * promise nobody consumes.
 */
export function isFloatingPromise(stmt: ts.Statement, ctx?: FileContext): ts.CallExpression | null {
  if (!ts.isExpressionStatement(stmt)) return null;
  const expr = stmt.expression;
  if (!ts.isCallExpression(expr)) return null;
  if (!isPromiseProducingCall(expr, ctx)) return null;

  // `.catch()` attached means the rejection is handled.
  let cur: ts.Node = expr;
  while (cur.parent) {
    const p = cur.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === cur) {
      if (p.name.getText() === "catch" || p.name.getText() === "finally") return null;
      cur = p;
      continue;
    }
    if (ts.isCallExpression(p) && p.expression === cur) {
      cur = p;
      continue;
    }
    break;
  }
  return expr;
}

interface BindingWrite { node: ts.Node; value?: ts.Expression }
interface WriteIndex { writes: Map<ts.Declaration, BindingWrite[]>; references: Set<ts.Declaration>; budget: AnalysisBudget }
const bindingWrites = new WeakMap<ts.SourceFile, WriteIndex>();

function directDefinition(node: ts.Node): ts.Declaration | undefined {
  const direct = symbolOf(node)?.valueDeclaration;
  // Keep local aliases as bindings so their own assignments cannot disappear.
  return direct && (ts.isVariableDeclaration(direct) || ts.isParameter(direct) || ts.isPropertyAssignment(direct) || ts.isPropertyDeclaration(direct)) ? direct : definitionOf(node);
}

function statementList(node: ts.Node): ts.Block | ts.SourceFile | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) if (ts.isBlock(parent) || ts.isSourceFile(parent)) return parent;
  return undefined;
}

function writeIndex(sf: ts.SourceFile): WriteIndex {
  const cached = bindingWrites.get(sf); if (cached) return cached;
  const result: WriteIndex = { writes: new Map(), references: new Set(), budget: new AnalysisBudget("Promise binding writes", projectWorkLimit([sf])) };
  const add = (target: ts.Node, node: ts.Node, value?: ts.Expression): void => {
    result.budget.take();
    if (ts.isIdentifier(target)) {
      const declaration = symbolOf(target)?.valueDeclaration;
      if (declaration) { const entries = result.writes.get(declaration) ?? []; entries.push({ node, value }); result.writes.set(declaration, entries); }
    } else if (ts.isPropertyAccessExpression(target)) {
      const declaration = definitionOf(target);
      if (declaration && (ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration))) {
        const entries = result.writes.get(declaration) ?? [];
        entries.push({ node, value }); result.writes.set(declaration, entries);
      }
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
    if (ts.isIdentifier(node)) {
      const declaration = symbolOf(node)?.valueDeclaration;
      if (declaration && (ts.isVariableDeclaration(declaration) || ts.isFunctionDeclaration(declaration)) && declaration.name !== node) result.references.add(declaration);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      add(node.left, node, node.operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isIdentifier(node.left) || ts.isPropertyAccessExpression(node.left)) ? node.right : undefined);
    } else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) add(node.operand, node);
    ts.forEachChild(node, child => { pending.push(child); });
  }
  for (const entries of result.writes.values()) entries.sort((a, b) => a.node.pos - b.node.pos);
  bindingWrites.set(sf, result); return result;
}

/** Resolve only assignments that dominate the use in the same straight-line list.
 * Branch/nested writes invalidate initializer evidence instead of inventing flow. */
function currentInitializer(declaration: ts.VariableDeclaration, use: ts.Node): ts.Expression | undefined {
  const index = writeIndex(declaration.getSourceFile());
  const writes = index.writes.get(declaration);
  if (!writes?.length) return declaration.initializer;
  const list = statementList(declaration);
  if (!list || statementList(use) !== list || declaration.getSourceFile() !== use.getSourceFile()) return undefined;
  let value = declaration.initializer;
  for (const write of writes) {
    index.budget.take();
    const statement = write.node.parent;
    if (!ts.isExpressionStatement(statement) || statement.parent !== list || !write.value) return undefined;
    if (write.node.end < use.pos) value = write.value;
  }
  return value;
}

/** An exported entry with no local references is reached externally after
 * module initialization. Local references may invoke it during startup, so
 * those entries cannot use the final startup value as proof. */
function exportedEntry(use: ts.Node, sf: ts.SourceFile): boolean {
  let entry: ts.Node | undefined;
  for (let node: ts.Node | undefined = use; node && node !== sf; node = node.parent) {
    if (ts.isFunctionLike(node)) entry = node;
  }
  if (!entry) return false;
  if (ts.isFunctionDeclaration(entry) && entry.parent === sf) return !writeIndex(sf).references.has(entry) && !!ts.getModifiers(entry)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
  if ((ts.isArrowFunction(entry) || ts.isFunctionExpression(entry)) && ts.isVariableDeclaration(entry.parent)) {
    const statement = entry.parent.parent.parent;
    return !writeIndex(sf).references.has(entry.parent) && ts.isVariableStatement(statement) && statement.parent === sf && !!ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
  }
  return false;
}

/** Properties retain declaration identity, including distinct same-named object
 * members. Writes in unknown control flow invalidate initializer evidence. */
function propertyInitializer(declaration: ts.PropertyAssignment | ts.PropertyDeclaration, use: ts.Node): ts.Expression | undefined {
  const sf = declaration.getSourceFile(), index = writeIndex(sf), writes = index.writes.get(declaration);
  if (!writes?.length) return declaration.initializer;
  if (sf !== use.getSourceFile()) return undefined;
  const list = statementList(declaration), sameList = statementList(use) === list;
  const startup = list === sf && exportedEntry(use, sf);
  if (!list || (!sameList && !startup)) return undefined;
  let value = declaration.initializer;
  for (const write of writes) {
    index.budget.take();
    const statement = write.node.parent;
    if (!ts.isExpressionStatement(statement) || statement.parent !== list || !write.value) return undefined;
    if (startup || write.node.end < use.pos) value = write.value;
  }
  return value;
}

function callableHandler(node: ts.Expression | undefined, seen = new Set<ts.Node>(), use: ts.Node | undefined = node): boolean {
  if (!node || !use) return false;
  if (seen.has(node) || seen.size > 64) return true; // Unknown handlers are not proof of an error.
  const next = new Set(seen).add(node);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return callableHandler(node.expression, next, use);
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const declaration = directDefinition(node);
    if (declaration && ts.isVariableDeclaration(declaration)) {
      const value = currentInitializer(declaration, use);
      return value ? callableHandler(value, next, value) : true;
    }
    if (ts.isIdentifier(node) && node.text === "undefined" && !declaration) return false;
    return true;
  }
  // A call can return a callable handler, but literals/objects cannot catch a rejection.
  return ts.isCallExpression(node) || ts.isConditionalExpression(node);
}

function asyncCallable(node: ts.Node | undefined, seen = new Set<ts.Node>(), use: ts.Node | undefined = node): boolean {
  if (!node || !use || seen.has(node) || seen.size > 64) return false;
  const next = new Set(seen).add(node);
  if (ts.isVariableDeclaration(node)) { const value = currentInitializer(node, use); return asyncCallable(value, next, value); }
  if (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) { const value = propertyInitializer(node, use); return asyncCallable(value, next, value); }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return asyncCallable(node.expression, next, use);
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) return asyncCallable(directDefinition(node), next, use);
  return ts.isFunctionLike(node) && ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword);
}

/** Follow known promise origins, rather than unrelated synchronous then/finally methods. */
function isPromiseValue(node: ts.Expression, seen = new Set<ts.Node>()): boolean {
  if (seen.has(node) || seen.size > 64) return false;
  const next = new Set(seen).add(node);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return isPromiseValue(node.expression, next);
  if (ts.isIdentifier(node)) {
    const declaration = definitionOf(node);
    return !!declaration && ts.isVariableDeclaration(declaration) && !!declaration.initializer && isPromiseValue(declaration.initializer, next);
  }
  if (ts.isNewExpression(node)) return ts.isIdentifier(node.expression) && node.expression.text === "Promise" && !symbolOf(node.expression)?.declarations?.length;
  if (!ts.isCallExpression(node)) return false;
  if (isPromiseProducingCall(node)) return true;
  if (asyncCallable(node.expression)) return true;
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const { expression: receiver, name } = node.expression;
  if (ts.isIdentifier(receiver) && receiver.text === "Promise" && !symbolOf(receiver)?.declarations?.length && ["resolve", "reject", "all", "allSettled", "race", "any"].includes(name.text)) return true;
  return ["then", "catch", "finally"].includes(name.text) && isPromiseValue(receiver, next);
}

/** A discarded rejection or chain without an effective rejection handler. */
export function isUnhandledRejection(stmt: ts.Statement): ts.CallExpression | null {
  if (!ts.isExpressionStatement(stmt) || !ts.isCallExpression(stmt.expression)) return null;
  const call = stmt.expression;
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  const method = call.expression.name.text;
  const receiver = call.expression.expression;
  if (method === "reject" && ts.isIdentifier(receiver) && receiver.text === "Promise" && !symbolOf(receiver)?.declarations?.length) return call;
  if (!["catch", "then", "finally"].includes(method) || !isPromiseValue(receiver)) return null;
  if (method === "catch") return callableHandler(call.arguments[0]) ? null : call;
  if (method === "then") return callableHandler(call.arguments[1]) ? null : call;
  return call;
}
