import { bindingWriteIndex, currentInitializer, definitionOf, exportedEntry, isHttpFetch, precedingInitializer, statementList, symbolOf, type BindingWrite } from "./bindings.js";
export { currentInitializer } from "./bindings.js";
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

function member(node: ts.Expression): { receiver: ts.Expression; name: string } | undefined {
  if (ts.isPropertyAccessExpression(node)) return { receiver: node.expression, name: node.name.text };
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return { receiver: node.expression, name: node.argumentExpression.text };
  }
  return undefined;
}

/**
 * True when the call is a database write we are confident about.
 *
 * This used to accept any `something.create()` in a file that happened to
 * import an ORM, which flagged every `headers.set()` and `stream.write()` in
 * the world. Now the receiver has to be a database-ish client or a model we
 * have evidence for.
 */
export function isDbWriteCall(node: ts.CallExpression, ctx?: FileContext): boolean {
  const target = member(node.expression);
  if (!target || !DB_WRITE_METHODS.has(target.name)) return false;
  const receiver = target.receiver.getText();
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
  const target = member(node.expression);
  if (!target) return false;
  const method = target.name;
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
  let expr = stmt.expression;
  while (transparent(expr)) expr = expr.expression;
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

function transparent(node: ts.Node): node is ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression
  | ts.SatisfiesExpression | ts.TypeAssertion {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
    || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node);
}

function directDefinition(node: ts.Node): ts.Declaration | undefined {
  // The checker attaches literal computed-member identity to the key node.
  const key = ts.isElementAccessExpression(node) && (ts.isStringLiteralLike(node.argumentExpression)
    || ts.isNumericLiteral(node.argumentExpression)) ? node.argumentExpression : node;
  const direct = symbolOf(key)?.valueDeclaration;
  // Keep local aliases as bindings so their own assignments cannot disappear.
  return direct && (ts.isVariableDeclaration(direct) || ts.isParameter(direct) || ts.isPropertyAssignment(direct) || ts.isPropertyDeclaration(direct)) ? direct : definitionOf(node);
}

const initializerReads = new WeakMap<ts.Declaration, WeakMap<ts.Node, ts.Expression | null>>();
interface PropertyHistories {
  unknown: boolean;
  receivers: Map<ts.Node, BindingWrite[]>;
  checked: Map<ts.Node, { list: ts.Node | undefined; entries?: BindingWrite[] }>;
}
const propertyHistories = new WeakMap<ts.Declaration, PropertyHistories>();
const independentInstances = new WeakMap<ts.ClassLikeDeclaration, boolean>();
const classWriteHistories = new WeakMap<ts.ClassDeclaration, { list?: ts.Node; first: number }>();

function unchangedClassBinding(declaration: ts.ClassDeclaration, use: ts.Node): boolean {
  const sf = declaration.getSourceFile(), index = bindingWriteIndex(sf), writes = index.writes.get(declaration);
  if (!writes?.length) return true;
  let history = classWriteHistories.get(declaration);
  if (!history) {
    const list = statementList(declaration);
    const ordered = !!list && writes.every(write => {
      index.budget.take();
      return ts.isExpressionStatement(write.node.parent) && write.node.parent.parent === list && !!write.value;
    });
    history = { list: ordered ? list : undefined, first: writes[0].node.end };
    classWriteHistories.set(declaration, history);
  }
  // A capture before a later straight-line reassignment still owns the old
  // constructor. A changed or ambiguously timed binding proves no allocation.
  return sf === use.getSourceFile() && !!history.list && statementList(use) === history.list && use.pos <= history.first;
}

function allocatesIndependentInstance(node: ts.ClassLikeDeclaration): boolean {
  const cached = independentInstances.get(node);
  if (cached !== undefined) return cached;
  independentInstances.set(node, false);
  // Constructors may return an existing object; an unknown base/decorator can
  // do the same. Such allocations cannot prove separate receiver identities.
  if (node.heritageClauses?.length || ts.getDecorators(node)?.length) return false;
  const budget = bindingWriteIndex(node.getSourceFile()).budget;
  for (const member of node.members) {
    budget.take();
    if (!ts.isConstructorDeclaration(member) || !member.body) continue;
    const pending: ts.Node[] = [member.body];
    while (pending.length) {
      budget.take(); const current = pending.pop()!;
      if (ts.isReturnStatement(current) && current.expression) return false;
      if (ts.isFunctionLike(current) || ts.isClassLike(current)) continue;
      ts.forEachChild(current, child => { pending.push(child); });
    }
  }
  independentInstances.set(node, true); return true;
}

/** Allocations and captured aliases identify one receiver. A class field
 * declaration alone does not identify which instance owns a property write. */
function receiverIdentity(node: ts.Node, use: ts.Node, seen = new Set<ts.Node>()): ts.Node | undefined {
  if (seen.has(node) || seen.size > 64) return undefined;
  const next = new Set(seen).add(node);
  bindingWriteIndex(node.getSourceFile()).budget.take();
  if (transparent(node)) return receiverIdentity(node.expression, use, next);
  if (ts.isObjectLiteralExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) return node;
  if (ts.isNewExpression(node)) {
    const constructor = receiverIdentity(node.expression, node.expression, next);
    return constructor && (ts.isClassDeclaration(constructor) || ts.isClassExpression(constructor)) && allocatesIndependentInstance(constructor) ? node : undefined;
  }
  if (!ts.isIdentifier(node)) return undefined;
  const declaration = symbolOf(node)?.valueDeclaration;
  if (declaration && ts.isVariableDeclaration(declaration)) {
    const value = currentInitializer(declaration, use);
    return value ? receiverIdentity(value, value, next) : undefined;
  }
  return declaration && (ts.isClassExpression(declaration)
    || ts.isClassDeclaration(declaration) && unchangedClassBinding(declaration, use)) ? declaration : undefined;
}

/** Property histories belong to a declaration and an exact receiver together.
 * Unknown receivers and control flow cannot establish a replacement value. */
function propertyInitializer(declaration: ts.PropertyAssignment | ts.PropertyDeclaration, use: ts.Node, receiver?: ts.Expression): ts.Expression | undefined {
  const sf = declaration.getSourceFile(), index = bindingWriteIndex(sf), writes = index.writes.get(declaration);
  index.budget.take();
  let reads = initializerReads.get(declaration);
  if (!reads) { reads = new WeakMap(); initializerReads.set(declaration, reads); }
  const cached = reads.get(use);
  if (cached !== undefined) return cached ?? undefined;
  const finish = (value?: ts.Expression) => { reads!.set(use, value ?? null); return value; };
  if (!writes?.length) return finish(declaration.initializer);
  if (sf !== use.getSourceFile()) return finish();
  const identity = receiver && receiverIdentity(receiver, use);
  if (!identity) return finish();
  let histories = propertyHistories.get(declaration);
  if (!histories) {
    histories = { unknown: false, receivers: new Map(), checked: new Map() };
    for (const write of writes) {
      index.budget.take();
      const target = write.target;
      const owner = target && (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))
        ? receiverIdentity(target.expression, write.node) : undefined;
      if (!owner) { histories.unknown = true; continue; }
      const entries = histories.receivers.get(owner) ?? [];
      entries.push(write); histories.receivers.set(owner, entries);
    }
    propertyHistories.set(declaration, histories);
  }
  if (histories.unknown) return finish();
  const entries = histories.receivers.get(identity);
  if (!entries?.length) return finish(declaration.initializer);
  let checked = histories.checked.get(identity);
  if (!checked) {
    const list = statementList(identity);
    const valid = !!list && entries.every(write => {
      index.budget.take();
      return ts.isExpressionStatement(write.node.parent) && write.node.parent.parent === list && !!write.value;
    });
    checked = { list, entries: valid ? entries : undefined }; histories.checked.set(identity, checked);
  }
  if (!checked.entries) return finish();
  const sameList = statementList(use) === checked.list;
  const startup = checked.list === sf && exportedEntry(use, sf);
  if (!sameList && !startup) return finish();
  return finish(startup ? checked.entries[checked.entries.length - 1].value
    : precedingInitializer(declaration, use, checked.entries, index.budget));
}

function callableHandler(node: ts.Expression | undefined, seen = new Set<ts.Node>(), use: ts.Node | undefined = node): boolean {
  if (!node || !use) return false;
  if (seen.has(node) || seen.size > 64) return true; // Unknown handlers are not proof of an error.
  const next = new Set(seen).add(node);
  if (transparent(node)) return callableHandler(node.expression, next, use);
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const declaration = directDefinition(node);
    if (declaration && ts.isVariableDeclaration(declaration)) {
      const value = currentInitializer(declaration, use);
      return value ? callableHandler(value, next, value) : true;
    }
    if (declaration && (ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration))) {
      const value = propertyInitializer(declaration, use, ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? node.expression : undefined);
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
  if (transparent(node)) return asyncCallable(node.expression, next, use);
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const declaration = directDefinition(node);
    if (declaration && (ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration))) {
      const value = propertyInitializer(declaration, use, ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? node.expression : undefined);
      return asyncCallable(value, next, value);
    }
    return asyncCallable(declaration, next, use);
  }
  return ts.isFunctionLike(node) && !("asteriskToken" in node && node.asteriskToken) && ts.canHaveModifiers(node)
    && !!ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword);
}

/** Follow known promise origins, rather than unrelated synchronous then/finally methods. */
function isPromiseValue(node: ts.Expression, seen = new Set<ts.Node>(), use: ts.Node = node): boolean {
  if (seen.has(node) || seen.size > 64) return false;
  const next = new Set(seen).add(node);
  if (transparent(node)) return isPromiseValue(node.expression, next, use);
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const declaration = directDefinition(node);
    const value = declaration && ts.isVariableDeclaration(declaration) ? currentInitializer(declaration, use)
      : declaration && (ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration))
        ? propertyInitializer(declaration, use, ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? node.expression : undefined) : undefined;
    return !!value && isPromiseValue(value, next, value);
  }
  if (ts.isNewExpression(node)) return ts.isIdentifier(node.expression) && node.expression.text === "Promise" && !symbolOf(node.expression)?.declarations?.length;
  if (!ts.isCallExpression(node)) return false;
  if (isPromiseProducingCall(node)) return true;
  if (asyncCallable(node.expression)) return true;
  const target = member(node.expression);
  if (!target) return false;
  const { receiver, name } = target;
  if (ts.isIdentifier(receiver) && receiver.text === "Promise" && !symbolOf(receiver)?.declarations?.length && ["resolve", "reject", "all", "allSettled", "race", "any"].includes(name)) return true;
  return ["then", "catch", "finally"].includes(name) && isPromiseValue(receiver, next);
}

/** A discarded rejection or chain without an effective rejection handler. */
export function isUnhandledRejection(stmt: ts.Statement): ts.CallExpression | null {
  if (!ts.isExpressionStatement(stmt)) return null;
  let expression = stmt.expression;
  while (transparent(expression)) expression = expression.expression;
  if (!ts.isCallExpression(expression)) return null;
  const call = expression;
  const target = member(call.expression);
  if (!target) return null;
  const { name: method, receiver } = target;
  if (method === "reject" && ts.isIdentifier(receiver) && receiver.text === "Promise" && !symbolOf(receiver)?.declarations?.length) return call;
  if (!["catch", "then", "finally"].includes(method) || !isPromiseValue(receiver)) return null;
  if (method === "catch") return callableHandler(call.arguments[0]) ? null : call;
  if (method === "then") return callableHandler(call.arguments[1]) ? null : call;
  return call;
}
