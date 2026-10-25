import ts from "typescript";
import { lineOf, snippetAt, makeFinding, isOrmCall } from "./common.js";
import type { Finding } from "../types.js";
import type { FileContext } from "../context.js";
import { Workspace } from "../workspace.js";

const LOOP_CALLEE = new Set(["forEach", "map", "flatMap", "filter"]);

export async function detectNPlusOne(root: string, ws?: Workspace): Promise<Finding[]> {
  const out: Finding[] = [];
  const workspace = ws ?? (await Workspace.load(root));
  for (const unit of workspace.units) {
    ts.forEachChild(unit.sf, (node) => walk(node, unit.sf, unit.content, unit.rel, unit.ctx, out, 0));
  }
  return out;
}

function walk(node: ts.Node, sf: ts.SourceFile, content: string, rel: string, ctx: FileContext, out: Finding[], loopDepth: number) {
  let depth = loopDepth;
  if (ts.isFunctionLike(node)) {
    let container: ts.Node = node;
    while (ts.isParenthesizedExpression(container.parent)) container = container.parent;
    const parent = container.parent;
    const immediate = ts.isCallExpression(parent) && (parent.expression === container ||
      (parent.arguments[0] === container && ts.isPropertyAccessExpression(parent.expression) && LOOP_CALLEE.has(parent.expression.name.text)));
    if (!immediate) depth = 0;
  }
  if (isLoop(node)) depth += 1;

  const returnedCall = ts.isCallExpression(node) && (ts.isReturnStatement(node.parent)
    || (ts.isArrowFunction(node.parent) && node.parent.body === node));
  const call = ts.isAwaitExpression(node) && ts.isCallExpression(node.expression) ? node.expression : returnedCall ? node : undefined;
  if (depth > 0 && call && isOrmCall(call, ctx)) {
    const ln = lineOf(sf, node);
    out.push(makeFinding({ id: "n-plus-one", category: "DB", severity: "high", confidence: "medium",
      file: rel, line: ln, message: "ORM/database call repeated inside a loop or collection callback; this is an N+1 pattern.",
      scaleTrigger: "One database round-trip per item grows with collection size, even when executed concurrently.",
      suggestedFix: "Batch queries with an IN filter or join instead of one read per item.", snippet: snippetAt(content, ln) }));
    return;
  }

  ts.forEachChild(node, (c) => walk(c, sf, content, rel, ctx, out, depth));
}

function isLoop(node: ts.Node): boolean {
  if (
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  )
    return true;
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && LOOP_CALLEE.has(node.expression.name.getText())) {
    return true;
  }
  return false;
}
