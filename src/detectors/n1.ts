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
  if (isLoop(node)) depth += 1;

  if (depth > 0 && ts.isAwaitExpression(node) && ts.isCallExpression(node.expression) && isOrmCall(node.expression, ctx)) {
    const ln = lineOf(sf, node);
    out.push(
      makeFinding({
        id: "n-plus-one",
        category: "DB",
        severity: "high",
        confidence: "medium",
        file: rel,
        line: ln,
        message: "ORM/database call awaited inside a loop; this is an N+1 pattern that scales poorly.",
        scaleTrigger: "Breaks as list/collection sizes grow: O(n) DB round-trips per request.",
        suggestedFix: "Batch the read (e.g. Prisma findMany with `in`, or a join) and hydrate in memory; or prefetch related rows.",
        snippet: snippetAt(content, ln),
      }),
    );
    return; // don't traverse further inside this await
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
