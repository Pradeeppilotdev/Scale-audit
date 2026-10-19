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
  if (ts.isIdentifier(node.expression)) {
    // `fetch` always returns a promise.
    return node.expression.text === "fetch";
  }
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const method = node.expression.name.getText();
  if (method === "then" || method === "catch" || method === "finally") return false;
  if (method === "fetch") return true;
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

/** True when a `.then()` chain has no rejection handler. */
export function isUnhandledRejection(stmt: ts.Statement): ts.CallExpression | null {
  if (!ts.isExpressionStatement(stmt)) return null;
  const expr = stmt.expression;
  if (!ts.isCallExpression(expr)) return null;
  if (!ts.isPropertyAccessExpression(expr.expression)) return null;
  if (expr.expression.name.getText() !== "then") return null;
  // `then(onFulfilled, onRejected)` handles the rejection already.
  if (expr.arguments.length >= 2) return null;
  // `Promise.resolve().then(...)` cannot reject on the source side.
  const source = expr.expression.expression;
  if (ts.isCallExpression(source) && ts.isPropertyAccessExpression(source.expression)) {
    if (source.expression.expression.getText() === "Promise") {
      const method = source.expression.name.getText();
      if (method === "resolve" || method === "reject") return null;
    }
  }

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
