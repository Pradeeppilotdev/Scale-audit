import { checkerFor, definitionOf, importedBinding, isAxiosBinding, isHttpFetch, symbolOf } from "../bindings.js";
import ts from "typescript";
import { lineOf, snippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";
import { Workspace } from "../workspace.js";

const AXIOS_METHODS = new Set(["get", "post", "put", "delete", "patch", "head", "options", "request"]);
export async function detectOutboundTimeouts(root: string, ws?: Workspace): Promise<Finding[]> {
  const out: Finding[] = [];
  const workspace = ws ?? (await Workspace.load(root));
  const clients = new Map<ts.Declaration, Client>();
  for (const { sf } of workspace.units) {
    const collect = (node: ts.Node) => {
      const init = ts.isVariableDeclaration(node) ? node.initializer : ts.isExportAssignment(node) ? node.expression : undefined;
      if (init && ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression)
        && init.expression.name.text === "create" && isAxiosBinding(init.expression.expression)
        && (ts.isVariableDeclaration(node) || ts.isExportAssignment(node))) {
        clients.set(node, { config: asObject(init.arguments[0]) ?? undefined, mutated: false });
      }
      ts.forEachChild(node, collect);
    };
    collect(sf);
  }
  for (const { sf } of workspace.units) {
    const mutations = (node: ts.Node) => {
      // Defaults are mutable even for const clients. Any reference to defaults
      // invalidates inherited assumptions; explicit call options still apply.
      if (ts.isPropertyAccessExpression(node) && node.name.text === "defaults") {
        const declaration = definitionOf(node.expression);
        const client = declaration && clients.get(declaration);
        if (client) client.mutated = true;
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(node.left)) {
        const declaration = definitionOf(node.left);
        const client = declaration && clients.get(declaration);
        if (client) client.mutated = true;
      }
      ts.forEachChild(node, mutations);
    };
    mutations(sf);
  }
  for (const { rel, content, sf } of workspace.units) {
    visit(sf, sf, content, rel, clients, checkerFor(sf), out);
  }
  return out;
}

function visit(node: ts.Node, sf: ts.SourceFile, content: string, rel: string, clients: Map<ts.Declaration, Client>, checker: ts.TypeChecker, out: Finding[]) {
  if (ts.isCallExpression(node)) {
    const target = calleeInfo(node.expression, clients, checker);
    if (target) {
      const check = timeoutCheck(node, target);
      if (check !== "bounded") {
        out.push(buildFinding(check, target.name, content, rel, lineOf(sf, node)));
      }
    }
  }
  ts.forEachChild(node, (c) => visit(c, sf, content, rel, clients, checker, out));
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
      message: `Outbound HTTP call (${callName}) uses configuration that could not be resolved; could not confirm a timeout/abort signal.`,
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

interface Client { config?: ts.ObjectLiteralExpression; mutated: boolean }
interface Target { name: string; kind: "fetch" | "axios" | "http"; defaults?: ts.ObjectLiteralExpression; unknownDefaults?: boolean }

function calleeInfo(expr: ts.Expression, clients: Map<ts.Declaration, Client>, checker: ts.TypeChecker): Target | null {
  if (isHttpFetch(expr)) return { name: "fetch", kind: "fetch" };
  if (ts.isPropertyAccessExpression(expr)) {
    const method = expr.name.getText();
    const symbol = ts.isIdentifier(expr.expression) ? checker.getSymbolAtLocation(expr.expression) : undefined;
    const declaration = definitionOf(expr.expression);
    const client = declaration && clients.get(declaration);
    const isParameter = symbol?.declarations?.some(ts.isParameter);
    if ((client || (isAxiosBinding(expr.expression) && !isParameter)) && AXIOS_METHODS.has(method)) {
      return { name: `axios.${method}`, kind: "axios", defaults: client?.mutated ? undefined : client?.config,
        unknownDefaults: client ? client.mutated || !client.config : false };
    }
    const receiver = expr.expression;
    const binding = importedBinding(receiver);
    const nativeHttp = binding && /^(?:node:)?https?$/.test(binding.module) && ["*", "default"].includes(binding.name);
    const conventionalGlobal = ts.isIdentifier(receiver) && /^(http|https)$/.test(receiver.text) && !symbolOf(receiver)?.declarations?.length;
    if ((nativeHttp || conventionalGlobal) && ["request", "get"].includes(method)) return { name: `http.${method}`, kind: "http" };
  }
  const binding = importedBinding(expr);
  if (binding && /^(?:node:)?https?$/.test(binding.module) && ["request", "get"].includes(binding.name)) return { name: `http.${binding.name}`, kind: "http" };
  const declaration = definitionOf(expr);
  const client = declaration && clients.get(declaration);
  if (client) return { name: "axios", kind: "axios", defaults: client.mutated ? undefined : client.config, unknownDefaults: client.mutated || !client.config };
  if (isAxiosBinding(expr)) return { name: "axios", kind: "axios" };
  return null;
}

type TimeoutCheck = "bounded" | "unbounded" | "unknown" | "cancellation-only";

function timeoutCheck(node: ts.CallExpression, target: Target): TimeoutCheck {
  const args = node.arguments;
  let config: ts.Expression | undefined;

  if (target.kind === "fetch") {
    // fetch(url, config?)
    config = args[1];
  } else if (target.kind === "axios") {
    // axios(config) vs axios.get(url, config?)
    const method = target.name.split(".")[1];
    config = target.name === "axios" || method === "request"
      ? (args.length > 1 ? args[1] : args[0])
      : args[["post", "put", "patch"].includes(method) ? 2 : 1];
  } else {
    // http.request(options) vs http.request(url, options?)
    config = args[1] && !ts.isArrowFunction(args[1]) && !ts.isFunctionExpression(args[1]) ? args[1] : args[0];
  }

  if (!config) return target.unknownDefaults ? "unknown" : target.defaults ? objectTimeoutVerdict(target.defaults, target.kind) : "unbounded";

  const obj = asObject(config);
  if (obj) return objectTimeoutVerdict(obj, target.kind, target.defaults, target.unknownDefaults);

  // String-literal argument in the config position is a URL (http.request("...")).
  if (ts.isStringLiteral(config) || ts.isNoSubstitutionTemplateLiteral(config) || ts.isTemplateExpression(config)) {
    return "unbounded";
  }

  // Config lives in a variable/helper: cannot confirm.
  return "unknown";
}

/** Only supported options and proven timer signals count as bounded. */
function objectTimeoutVerdict(config: ts.ObjectLiteralExpression, kind: Target["kind"], defaults?: ts.ObjectLiteralExpression, unknownDefaults = false): TimeoutCheck {
  let timeout: ts.Expression | undefined;
  let signal: ts.Expression | undefined;
  let unknown = unknownDefaults;
  for (const obj of defaults ? [defaults, config] : [config]) {
    for (const p of obj.properties) {
      if (ts.isSpreadAssignment(p) || !p.name || ts.isComputedPropertyName(p.name)) {
        timeout = signal = undefined;
        unknown = true;
        continue;
      }
      const name = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : "";
      const value = ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : undefined;
      if (name === "timeout") timeout = value;
      if (name === "signal") signal = value;
    }
  }
  if (signal && timerSignal(signal)) return "bounded";
  // Node http timeout emits an event; it does not itself abort the request.
  if (kind === "axios" && timeout) {
    if (ts.isNumericLiteral(timeout)) {
      if (Number.isFinite(Number(timeout.text)) && Number(timeout.text) > 0) return "bounded";
    } else if (!ts.isPrefixUnaryExpression(timeout) && timeout.kind !== ts.SyntaxKind.NullKeyword) unknown = true;
  }
  if (unknown) return "unknown";
  if (signal) return "cancellation-only";
  return "unbounded";
}

function timerSignal(expr: ts.Expression): boolean {
  if (!ts.isCallExpression(expr) || !ts.isPropertyAccessExpression(expr.expression)) return false;
  const receiver = expr.expression.expression;
  const globalSignal = ts.isIdentifier(receiver) && receiver.text === "AbortSignal" && !symbolOf(receiver)?.declarations?.length;
  const qualifiedSignal = ts.isPropertyAccessExpression(receiver) && receiver.name.text === "AbortSignal"
    && ts.isIdentifier(receiver.expression) && receiver.expression.text === "globalThis" && !symbolOf(receiver.expression)?.declarations?.length;
  if (!globalSignal && !qualifiedSignal) return false;
  if (expr.expression.name.text === "timeout") {
    const value = expr.arguments[0];
    return !!value && ts.isNumericLiteral(value) && Number.isSafeInteger(Number(value.text)) && Number(value.text) >= 0;
  }
  if (expr.expression.name.text === "any" && expr.arguments[0] && ts.isArrayLiteralExpression(expr.arguments[0])) {
    return expr.arguments[0].elements.some((element) => ts.isExpression(element) && timerSignal(element));
  }
  return false;
}

function asObject(arg: ts.Expression | undefined): ts.ObjectLiteralExpression | null {
  if (!arg) return null;
  let val = arg;
  while (ts.isAsExpression(val) || ts.isParenthesizedExpression(val) || ts.isTypeAssertionExpression(val)) {
    val = (val as any).expression;
  }
  return ts.isObjectLiteralExpression(val) ? val : null;
}
