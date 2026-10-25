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
  if (isHttpFetch(node.expression)) return true;
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
  // `void doThing()` is an explicit, intentional discard.
  if (ts.isVoidExpression(stmt as never)) return null;
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

function callableHandler(node: ts.Expression | undefined): boolean {
  return !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node)
    || (ts.isIdentifier(node) && node.text !== "undefined") || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node));
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
  const definition = definitionOf(node.expression);
  if (definition && ts.canHaveModifiers(definition) && ts.getModifiers(definition)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return true;
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
