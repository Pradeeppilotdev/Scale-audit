import ts from "typescript";
import { lineOf, snippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";
import { Workspace } from "../workspace.js";

const AXIOS_METHODS = new Set(["get", "post", "put", "delete", "patch", "head", "options", "request"]);
// `axios.create({ timeout: ... })` at module scope configures a shared client.
const SHARED_AXIOS_TIMEOUT = /axios\.create\s*\(\s*\{[\s\S]{0,400}?timeout\s*:/;
// Only an explicit timer counts as a timeout; a bare AbortController signal is cancellation-only.
const REAL_TIMEOUT_EXPR = /AbortSignal\.timeout\s*\(/;

export async function detectOutboundTimeouts(root: string, ws?: Workspace): Promise<Finding[]> {
  const out: Finding[] = [];
  const workspace = ws ?? (await Workspace.load(root));
  for (const { rel, content, sf } of workspace.units) {
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
          const ln = lineOf(sf, node);
          out.push(buildFinding(check, target.name, content, rel, ln));
        }
      }
    }
  }
  ts.forEachChild(node, (c) => visit(c, sf, content, rel, sharedAxiosTimeout, out));
}

function buildFinding(check: Exclude<TimeoutCheck, "bounded">, callName: string, content: string, rel: string, ln: number): Finding {
  const base = {
    id: "outbound-no-timeout",
    category: "Resilience" as const,
    file: rel,
    line: ln,
    snippet: snippetAt(content, ln),
  };

  if (check === "cancellation-only") {
    return makeFinding({
      ...base,
      severity: "low",
      confidence: "low",
      message: `Outbound HTTP call (${callName}) has a cancellation signal but no timeout; a hung request is never aborted.`,
      scaleTrigger: "Cancellation signals only fire on unmount/dispose; a stalled downstream still holds the request open.",
      suggestedFix: "Add a real timeout: AbortSignal.any([signal, AbortSignal.timeout(5000)]) (or axios timeout).",
    });
  }

  if (check === "unknown") {
    return makeFinding({
      ...base,
      severity: "low",
      confidence: "low",
      message: `Outbound HTTP call (${callName}) uses a config object passed as a variable; could not confirm a timeout/abort signal.`,
      scaleTrigger: "A slow downstream stalls requests and can exhaust sockets/connections under load.",
      suggestedFix: "Set a timeout/AbortSignal (e.g. fetch(url, { signal: AbortSignal.timeout(5000) }) or axios timeout) and consider retries with backoff.",
    });
  }

  return makeFinding({
    ...base,
    severity: "medium",
    confidence: "medium",
    message: `Outbound HTTP call (${callName}) has no timeout/abort signal configured.`,
    scaleTrigger: "A slow downstream stalls requests and can exhaust sockets/connections under load.",
    suggestedFix: "Set a timeout/AbortSignal (e.g. fetch(url, { signal: AbortSignal.timeout(5000) }) or axios timeout) and consider retries with backoff.",
  });
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

type TimeoutCheck = "bounded" | "unbounded" | "unknown" | "cancellation-only";

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
  if (obj) return objectTimeoutVerdict(obj);

  // String-literal argument in the config position is a URL (http.request("...")).
  if (ts.isStringLiteral(config) || ts.isNoSubstitutionTemplateLiteral(config) || ts.isTemplateExpression(config)) {
    return "unbounded";
  }

  // Config lives in a variable/helper: cannot confirm.
  return "unknown";
}

function objectTimeoutVerdict(config: ts.ObjectLiteralExpression): Exclude<TimeoutCheck, "unknown"> {
  let hasRealTimeout = false;
  let hasSignal = false;
  for (const p of config.properties) {
    if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue;
    const name = p.name.getText().replace(/['"]/g, "");
    if (name === "timeout" || name === "timeoutMs") hasRealTimeout = true;
    if (name === "signal") {
      hasSignal = true;
      const valueText = ts.isPropertyAssignment(p) ? p.initializer.getText() : p.name.getText();
      if (REAL_TIMEOUT_EXPR.test(valueText)) hasRealTimeout = true;
    }
  }
  if (hasRealTimeout) return "bounded";
  if (hasSignal) return "cancellation-only";
  return "unbounded";
}

function asObject(arg: ts.Expression | undefined): ts.ObjectLiteralExpression | null {
  if (!arg) return null;
  let val = arg;
  while (ts.isAsExpression(val) || ts.isParenthesizedExpression(val) || ts.isTypeAssertionExpression(val)) {
    val = (val as any).expression;
  }
  return ts.isObjectLiteralExpression(val) ? val : null;
}
