import ts from "typescript";
import { listSourceFiles, readFileSafe, parseSource, lineOf, snippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";

const ALL_METHODS = new Set(["all", "allSettled"]);

export async function detectUnboundedConcurrency(root: string): Promise<Finding[]> {
  const out: Finding[] = [];
  const files = await listSourceFiles(root);
  for (const rel of files) {
    const content = await readFileSafe(root, rel);
    if (!content) continue;
    const sf = parseSource(rel, content);
    if (!sf) continue;
    visit(sf, sf, content, rel, out);
  }
  return out;
}

function visit(node: ts.Node, sf: ts.SourceFile, content: string, rel: string, out: Finding[]) {
  if (ts.isCallExpression(node) && isPromiseAll(node)) {
    const arg = node.arguments[0];
    if (arg && ts.isCallExpression(arg) && ts.isPropertyAccessExpression(arg.expression)) {
      const method = arg.expression.name.getText();
      if ((method === "map" || method === "flatMap") && !isLimited(arg)) {
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
  ts.forEachChild(node, (c) => visit(c, sf, content, rel, out));
}

function isPromiseAll(node: ts.CallExpression): boolean {
  const expr = node.expression;
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "Promise" &&
    ALL_METHODS.has(expr.name.getText())
  );
}

function calleeName(node: ts.CallExpression): string {
  return ts.isPropertyAccessExpression(node.expression) ? node.expression.name.getText() : "all";
}

/** Heuristic: already wrapped in a limiter/chunk helper. */
function isLimited(call: ts.CallExpression): boolean {
  const text = call.getText();
  return /limit|concurren|chunk|batch|semaphore|pLimit|p-queue|pMap/i.test(text);
}
