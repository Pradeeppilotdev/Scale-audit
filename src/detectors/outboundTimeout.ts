import ts from "typescript";
import { listSourceFiles, readFileSafe, parseSource, lineOf, snippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";

const AXIOS_METHODS = new Set(["get", "post", "put", "delete", "patch", "head", "options", "request"]);

export async function detectOutboundTimeouts(root: string): Promise<Finding[]> {
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
  if (ts.isCallExpression(node)) {
    const target = calleeInfo(node.expression);
    if (target) {
      const config = findConfigArg(node, target.kind);
      if (!hasTimeoutOrSignal(config)) {
        const ln = lineOf(sf, node);
        out.push(
          makeFinding({
            id: "outbound-no-timeout",
            category: "Resilience",
            severity: "medium",
            confidence: "medium",
            file: rel,
            line: ln,
            message: `Outbound HTTP call (${target.name}) has no timeout/abort signal configured.`,
            scaleTrigger: "A slow downstream stalls requests and can exhaust sockets/connections under load.",
            suggestedFix: "Set a timeout/AbortSignal (e.g. fetch(url, { signal: AbortSignal.timeout(5000) }) or axios timeout) and consider retries with backoff.",
            snippet: snippetAt(content, ln),
          }),
        );
      }
    }
  }
  ts.forEachChild(node, (c) => visit(c, sf, content, rel, out));
}

function calleeInfo(expr: ts.Expression): { name: string; kind: "fetch" | "axios" | "http" } | null {
  if (ts.isIdentifier(expr) && expr.text === "fetch") return { name: "fetch", kind: "fetch" };
  if (ts.isPropertyAccessExpression(expr)) {
    const receiver = expr.expression.getText();
    const method = expr.name.getText();
    if (receiver === "axios" && AXIOS_METHODS.has(method)) return { name: `axios.${method}`, kind: "axios" };
    if ((receiver === "http" || receiver === "https") && method === "request") return { name: `${receiver}.request`, kind: "http" };
  }
  if (ts.isIdentifier(expr) && expr.text === "axios") return { name: "axios", kind: "axios" };
  return null;
}

function findConfigArg(node: ts.CallExpression, kind: "fetch" | "axios" | "http"): ts.ObjectLiteralExpression | null {
  const candidates: (ts.Expression | undefined)[] = kind === "fetch" ? [node.arguments[1]] : [node.arguments[0], node.arguments[1]];
  for (const arg of candidates) {
    const obj = asObject(arg);
    if (obj) return obj;
  }
  return null;
}

function asObject(arg: ts.Expression | undefined): ts.ObjectLiteralExpression | null {
  if (!arg) return null;
  let val = arg;
  while (ts.isAsExpression(val) || ts.isParenthesizedExpression(val) || ts.isTypeAssertionExpression(val)) {
    val = (val as any).expression;
  }
  return ts.isObjectLiteralExpression(val) ? val : null;
}

function hasTimeoutOrSignal(config: ts.ObjectLiteralExpression | null): boolean {
  if (!config) return false;
  return config.properties.some((p) => {
    if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) return false;
    const name = p.name.getText().replace(/['"]/g, "");
    return name === "timeout" || name === "signal" || name === "timeoutMs";
  });
}
