import { isHttpFetch } from "../bindings.js";
import ts from "typescript";
import { lineOf, snippetAt, makeFinding, DB_RECEIVER } from "./common.js";
import type { Finding } from "../types.js";
import { Workspace } from "../workspace.js";

/**
 * Sequential awaits that could run concurrently.
 *
 * This is the mirror image of the unbounded-concurrency detector: there we warn
 * when too much work runs in parallel, here we warn when independent work runs
 * one after the other. A handler that awaits two independent calls serially
 * doubles its latency for no reason.
 *
 * Only reported when the awaits are provably independent (they share no
 * identifiers) and are not transaction/commit control flow.
 */
export async function detectSequentialAwaits(root: string, ws?: Workspace): Promise<Finding[]> {
  const out: Finding[] = [];
  const workspace = ws ?? (await Workspace.load(root));
  for (const { rel, content, sf } of workspace.units) {
    visit(sf, sf, content, rel, out);
  }
  return out;
}

/** Calls whose ordering is meaningful and must not be parallelised. */
const ORDERED_CALLS = /^(commit|rollback|begin|transaction|releaseLock|acquireLock|lock|unlock|selectForUpdate|tx)$/i;

function visit(node: ts.Node, sf: ts.SourceFile, content: string, rel: string, out: Finding[]): void {
  if (ts.isBlock(node)) {
    const stmts = node.statements;
    for (let i = 0; i < stmts.length - 1; i++) {
      const a = awaitedExpression(stmts[i]);
      const b = awaitedExpression(stmts[i + 1]);
      if (!a || !b) continue;
      if (hasOrderedCall(a) || hasOrderedCall(b)) continue;
      if (!independent(stmts[i], a, stmts[i + 1], b)) continue;
      // Only worth reporting when both calls are real I/O. Two sequential
      // `await`s on in-memory work is not a scale problem.
      if (!isNetworkOrDbCall(a) || !isNetworkOrDbCall(b)) continue;

      const ln = lineOf(sf, stmts[i]);
      out.push(
        makeFinding({
          id: "sequential-awaits",
          category: "Performance",
          severity: "low",
          confidence: "low",
          file: rel,
          line: ln,
          message: "Two independent calls are awaited one after the other; they can run concurrently.",
          scaleTrigger: "Latency is the sum of both calls instead of the max, and it compounds on every request.",
          suggestedFix: "Run them together with `await Promise.all([a, b])` if the ordering is not intentional.",
          snippet: snippetAt(content, ln),
        }),
      );
    }
  }
  ts.forEachChild(node, (c) => visit(c, sf, content, rel, out));
}

/**
 * The awaited expression of a statement.
 *
 * Handles both `await f();` and `const x = await f();`, which are equally
 * common in real code.
 */
function awaitedExpression(stmt: ts.Statement): ts.Expression | null {
  if (ts.isExpressionStatement(stmt)) {
    return ts.isAwaitExpression(stmt.expression) ? stmt.expression : null;
  }
  if (ts.isVariableStatement(stmt)) {
    for (const decl of stmt.declarationList.declarations) {
      if (decl.initializer && ts.isAwaitExpression(decl.initializer)) return decl.initializer;
    }
  }
  return null;
}

/**
 * True when the awaited expression performs network or database I/O.
 *
 * This is what makes the finding worth reporting: awaiting two HTTP calls in a
 * row doubles the request latency, while awaiting two in-memory operations
 * does not matter.
 */
function isNetworkOrDbCall(expr: ts.Expression): boolean {
  let found = false;
  const walk = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (isHttpFetch(callee)) {
        found = true;
        return;
      }
      if (ts.isPropertyAccessExpression(callee)) {
        const recv = callee.expression.getText();
        const method = callee.name.getText();
        if (recv === "axios" && /^(get|post|put|patch|delete|head|options|request)$/.test(method)) {
          found = true;
          return;
        }
        if (/^(findMany|findAll|findFirst|findUnique|query|find|count|aggregate)$/.test(method) && DB_RECEIVER.test(recv)) {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(expr);
  return found;
}

function hasOrderedCall(expr: ts.Expression): boolean {
  let found = false;
  const walk = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const name = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.getText() : ts.isIdentifier(n.expression) ? n.expression.text : "";
      if (ORDERED_CALLS.test(name)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(expr);
  return found;
}

/**
 * Two awaits are independent when they share no identifiers and neither one
 * consumes a value declared by the other.
 */
function independent(stmtA: ts.Statement, a: ts.Expression, stmtB: ts.Statement, b: ts.Expression): boolean {
  const used = (expr: ts.Expression) => {
    const set = new Set<string>();
    const walk = (n: ts.Node) => {
      // `a.b` -> `b` is a property name, not a value.
      if (ts.isPropertyAccessExpression(n)) {
        walk(n.expression);
        return;
      }
      // `f(x)` -> `f` is a function reference, not a value.
      if (ts.isCallExpression(n)) {
        if (!ts.isIdentifier(n.expression)) walk(n.expression);
        for (const arg of n.arguments) walk(arg);
        return;
      }
      if (ts.isIdentifier(n)) {
        set.add(n.text);
        return;
      }
      ts.forEachChild(n, walk);
    };
    walk(expr);
    return set;
  };
  const declared = (stmt: ts.Statement) => {
    const set = new Set<string>();
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const collect = (name: ts.BindingName): void => {
          if (ts.isIdentifier(name)) set.add(name.text);
          else for (const element of name.elements) if (ts.isBindingElement(element)) collect(element.name);
        };
        collect(decl.name);
      }
    }
    return set;
  };

  const usedA = used(a);
  const usedB = used(b);
  if (usedA.size === 0 || usedB.size === 0) return false;

  for (const id of usedA) {
    if (usedB.has(id)) return false;
  }
  // `const res = await f(); const body = await res.json();` is dependent even
  // though the two expressions do not share an identifier.
  const declaredA = declared(stmtA);
  const declaredB = declared(stmtB);
  for (const id of declaredA) {
    if (usedB.has(id)) return false;
  }
  for (const id of declaredB) {
    if (usedA.has(id)) return false;
  }
  return true;
}
