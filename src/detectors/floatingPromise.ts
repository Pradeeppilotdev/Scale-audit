import ts from "typescript";
import { lineOf, snippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";
import type { FileContext } from "../context.js";
import { isFloatingPromise, isUnhandledRejection, isDbWriteCall } from "../signals.js";
import { Workspace } from "../workspace.js";

/** Optional internal site observer keeps downstream ownership checks tied to
 * the exact AST call, including multiple findings on the same source line. */
type FindingSiteObserver = (finding: Finding, call: ts.CallExpression) => void;

/**
 * Floating promises and unhandled rejections.
 *
 * `prisma.user.create({...})` without `await` is one of the most damaging bugs
 * in a Node service that only shows up under load: the write may never land and
 * a rejection kills the process. It is completely invisible to runtime
 * type-checking and to a human reading the code quickly.
 */
export async function detectFloatingPromises(root: string, ws?: Workspace, onSite?: FindingSiteObserver): Promise<Finding[]> {
  const out: Finding[] = [];
  const workspace = ws ?? (await Workspace.load(root));

  for (const { rel, content, sf, ctx } of workspace.units) {
    visit(sf, sf, content, rel, ctx, out, onSite);
  }
  return out;
}

function visit(node: ts.Node, sf: ts.SourceFile, content: string, rel: string, ctx: FileContext, out: Finding[], onSite?: FindingSiteObserver): void {
  if (ts.isExpressionStatement(node)) {
    const floating = isFloatingPromise(node, ctx);
    if (floating) {
      const isWrite = isDbWriteCall(floating, ctx);
      const ln = lineOf(sf, node);
      const name = calleeName(floating);
      const finding = makeFinding({
        id: "floating-promise",
        category: "Correctness",
        severity: isWrite ? "high" : "medium",
        confidence: isWrite ? "medium" : "low",
        file: rel,
        line: ln,
        message: isWrite
          ? `Database write "${name}" is not awaited; the write may never complete and a rejection becomes unhandled.`
          : `Promise-returning call "${name}" is not awaited; its result is discarded and failures are silent.`,
        scaleTrigger:
          "Under load, a dropped promise means lost writes, silently swallowed errors, and process-level unhandled rejections that can terminate the instance.",
        suggestedFix: "Await the call, or attach a `.catch()` handler and return the promise if the work must run in the background.",
        snippet: snippetAt(content, ln),
      });
      out.push(finding);
      onSite?.(finding, floating);
    }

    const unhandled = isUnhandledRejection(node);
    if (unhandled) {
      const ln = lineOf(sf, node);
      const finding = makeFinding({
        id: "unhandled-rejection",
        category: "Resilience",
        severity: "medium",
        confidence: "medium",
        file: rel,
        line: ln,
        message: "Promise chain is discarded without a rejection handler; a failure can become an unhandled rejection.",
        scaleTrigger: "One failed downstream call can crash the whole process instead of failing a single request.",
        suggestedFix: "Add a `.catch()` handler (or use `await` in a try/catch) so failures are contained.",
        snippet: snippetAt(content, ln),
      });
      out.push(finding);
      onSite?.(finding, unhandled);
    }
  }
  ts.forEachChild(node, (c) => visit(c, sf, content, rel, ctx, out, onSite));
}

function calleeName(call: ts.CallExpression): string {
  if (ts.isPropertyAccessExpression(call.expression)) {
    return call.expression.name.getText();
  }
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  return "call";
}
