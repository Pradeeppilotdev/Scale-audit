import ts from "typescript";
import { listSourceFiles, readFileSafe, parseSource, lineOf, snippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";

const AXIOS_METHODS = new Set(["get", "post", "put", "delete", "patch", "head", "options", "request"]);
// `axios.create({ timeout: ... })` at module scope configures a shared client.
const SHARED_AXIOS_TIMEOUT = /axios\.create\s*\(\s*\{[\s\S]{0,400}?timeout\s*:/;

export async function detectOutboundTimeouts(root: string): Promise<Finding[]> {
  const out: Finding[] = [];
  const files = await listSourceFiles(root);
  for (const rel of files) {
    const content = await readFileSafe(root, rel);
    if (!content) continue;
    const sf = parseSource(rel, content);
    if (!sf) continue;
    visit(sf, sf, content, rel, SHARED_AXIOS_TIMEOUT.test(content), out);
  }
  return out;
}

function visit(node: ts.Node, sf: ts.SourceFile, content: string, rel: string, sharedAxiosTimeout: boolean, out: Finding[]) {
  if (ts.isCallExpression(node)) {
    const target = calleeInfo(node.expression);
    if (target) {
      const sharedClientCovers = target.kind === "axios" && sharedAxiosTimeout;
      if (!sharedClientCovers) {
        const check = timeoutCheck(node, target);
        if (check !== "bounded") {
          const unknown = check === "unknown";
          const ln = lineOf(sf, node);
          out.push(
            makeFinding({
              id: "outbound-no-timeout",
              category: "Resilience",
              severity: unknown ? "low" : "medium",
              confidence: unknown ? "low" : "medium",
              file: rel,
              line: ln,
              message: unknown
                ? `Outbound HTTP call (${target.name}) uses a config object passed as a variable; could not confirm a timeout/abort signal.`
                : `Outbound HTTP call (${target.name}) has no timeout/abort signal configured.`,
              scaleTrigger: "A slow downstream stalls requests and can exhaust sockets/connections under load.",
              suggestedFix: "Set a timeout/AbortSignal (e.g. fetch(url, { signal: AbortSignal.timeout(5000) }) or axios timeout) and consider retries with backoff.",
              snippet: snippetAt(content, ln),
            }),
          );
        }
      }
    }
  }
  ts.forEachChild(node, (c) => visit(c, sf, content, rel, sharedAxiosTimeout, out));
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

type TimeoutCheck = "bounded" | "unbounded" | "unknown";

function timeoutCheck(node: ts.CallExpression, target: { name: string; kind: "fetch" | "axios" | "http" }): TimeoutCheck {
  const args = node.arguments;
  let config: ts.Expression | undefined;

  if (target.kind === "fetch") {
    // fetch(url, config?)
    config = args[1];
  } else if (target.kind === "axios") {
    // axios(config) vs axios.get(url, config?)
    config = target.name === "axios" ? args[0] : args[1];
  } else {
    // http.request(options) vs http.request(url, options?)
    config = args.length >= 2 ? args[1] : args[0];
  }

  if (!config) return "unbounded";

  const obj = asObject(config);
  if (obj) return hasTimeoutOrSignal(obj) ? "bounded" : "unbounded";

  // String-literal argument in the config position is a URL (http.request("...")).
  if (ts.isStringLiteral(config) || ts.isNoSubstitutionTemplateLiteral(config) || ts.isTemplateExpression(config)) {
    return "unbounded";
  }

  // Config lives in a variable/helper: cannot confirm.
  return "unknown";
}

function asObject(arg: ts.Expression | undefined): ts.ObjectLiteralExpression | null {
  if (!arg) return null;
  let val = arg;
  while (ts.isAsExpression(val) || ts.isParenthesizedExpression(val) || ts.isTypeAssertionExpression(val)) {
    val = (val as any).expression;
  }
  return ts.isObjectLiteralExpression(val) ? val : null;
}

function hasTimeoutOrSignal(config: ts.ObjectLiteralExpression): boolean {
  return config.properties.some((p) => {
    if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) return false;
    const name = p.name.getText().replace(/['"]/g, "");
    return name === "timeout" || name === "signal" || name === "timeoutMs";
  });
}
