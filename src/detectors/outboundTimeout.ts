import { axiosBodyMethod, axiosDefaultsAt, axiosHttpMethod, axiosInstance, axiosRequestInterceptorsObserved,
  currentImportedBinding, currentInitializer, definitionOf, isAxiosMethod, isHttpFetch, isNativeFetch,
  symbolOf, uncertainAxiosMethod, type AxiosDefaults } from "../bindings.js";
import ts from "typescript";
import { locationOf, sourceSnippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";
import { Workspace } from "../workspace.js";
import { nativeAbortSignalUnchanged, nativeRequestUnchanged } from "../nativeSignals.js";
import { AnalysisBudget, AnalysisLimitError, projectWorkLimit } from "../analysisBudget.js";

export async function detectOutboundTimeouts(root: string, ws?: Workspace): Promise<Finding[]> {
  const out: Finding[] = [];
  const workspace = ws ?? (await Workspace.load(root));
  // A sibling module can replace the process-wide factory used at this site.
  const nativeSignal = workspace.units.every(unit => nativeAbortSignalUnchanged(unit.sf));
  const context = new TimeoutContext(workspace, nativeSignal);
  for (const { rel, sf } of workspace.units) visit(sf, sf, rel, out, context);
  return out;
}

function visit(node: ts.Node, sf: ts.SourceFile, rel: string, out: Finding[], context: TimeoutContext) {
  if (ts.isCallExpression(node)) {
    const target = calleeInfo(node, context);
    if (target) {
      const check = timeoutCheck(node, target, context);
      if (check !== "bounded") {
        const {line, column} = locationOf(sf, node);
        out.push(buildFinding(check, target.name, sf, rel, line, column));
      }
    }
  }
  ts.forEachChild(node, (c) => visit(c, sf, rel, out, context));
}

function buildFinding(check: Exclude<TimeoutCheck, "bounded">, callName: string, sf: ts.SourceFile, rel: string, ln: number, column: number): Finding {
  const base = {
    id: "outbound-no-timeout",
    category: "Resilience" as const,
    file: rel,
    line: ln, column,
    snippet: sourceSnippetAt(sf, ln),
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

interface Target {
  name: string;
  kind: "fetch" | "axios" | "http";
  inherited?: DeadlineOptions;
  interceptor?: boolean;
}

function calleeInfo(call: ts.CallExpression, context: TimeoutContext): Target | null {
  const expr = call.expression;
  if (isHttpFetch(expr)) return { name: "fetch", kind: "fetch" };
  const binding = currentImportedBinding(expr);
  const method = axiosHttpMethod(binding);
  if (binding && method) {
    const name = method === "axios" ? method : `axios.${method}`;
    if (axiosRequestInterceptorsObserved(binding, call)) return { name, kind: "axios", interceptor: true };
    const local = axiosDefaultsAt(binding, call), create = axiosInstance(binding);
    if (!create) return { name, kind: "axios", inherited: defaultOptions(local) };
    // A mutable instance keeps its conservative advisory. An explicit
    // per-request deadline remains sufficient despite uncertain inherited options.
    return { name, kind: "axios", inherited: local.changed ? unknownOptions : context.created(create).options };
  }
  if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
    const receiver = expr.expression;
    const name = ts.isPropertyAccessExpression(expr) ? expr.name.text
      : ts.isStringLiteralLike(expr.argumentExpression) ? expr.argumentExpression.text : undefined;
    const conventional = ts.isIdentifier(receiver) && /^(http|https)$/.test(receiver.text) && !symbolOf(receiver)?.declarations?.length;
    if (conventional && (name === "request" || name === "get")) return { name: `http.${name}`, kind: "http" };
    // Preserve the low-confidence advisory when a formerly native client is
    // reassigned to a value whose HTTP configuration cannot be established.
    const receiverIdentity = currentImportedBinding(receiver);
    if (name && receiverIdentity && uncertainAxiosMethod(receiverIdentity, name, expr)) {
      return { name: `axios.${name}`, kind: "axios", inherited: unknownOptions };
    }
    if (name && !receiverIdentity && axiosHttpMethod({ module: "axios", name })) {
      const declaration = definitionOf(receiver);
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isCallExpression(declaration.initializer)
        && isAxiosMethod(declaration.initializer.expression, "create")) return { name: `axios.${name}`, kind: "axios", inherited: unknownOptions };
    }
  }
  if (binding && /^(?:node:)?https?$/.test(binding.module) && ["request", "get"].includes(binding.name)) return { name: `http.${binding.name}`, kind: "http" };
  return null;
}

type TimeoutCheck = "bounded" | "unbounded" | "unknown" | "cancellation-only";

function timeoutCheck(node: ts.CallExpression, target: Target, context: TimeoutContext): TimeoutCheck {
  if (target.interceptor) return "unknown";
  const args = node.arguments;
  let config: ts.Expression | undefined;
  let inherited = target.inherited ?? {};

  if (target.kind === "fetch") {
    // fetch(url, config?)
    config = args[1];
    if (args[0] && isNativeFetch(node.expression)) inherited = context.request(args[0]);
  } else if (target.kind === "axios") {
    // axios(config) vs axios.get(url, config?)
    const method = target.name.split(".")[1];
    config = target.name === "axios" || method === "request"
      ? (args.length > 1 ? args[1] : args[0])
      : args[axiosBodyMethod(method) ? 2 : 1];
  } else {
    // http.request(options) vs http.request(url, options?)
    config = args[1] && !ts.isArrowFunction(args[1]) && !ts.isFunctionExpression(args[1]) ? args[1] : args[0];
  }

  const perCall = config && !ts.isStringLiteralLike(config) && !ts.isTemplateExpression(config) ? context.options(config) : {};
  const effective = { ...inherited, ...perCall };
  // Web IDL treats an undefined dictionary member as absent. null explicitly
  // disconnects the input Request's signal.
  if (target.kind === "fetch" && perCall.signal && absentValue(perCall.signal)) effective.signal = inherited.signal;
  const { timeout, signal } = effective;
  if (signal && context.nativeSignal && context.hasTimer(signal)) return "bounded";
  let unknown = signal === null || target.kind === "axios" && timeout === null;
  // Node http timeout emits an event; it does not itself abort the request.
  if (target.kind === "axios" && timeout) {
    if (ts.isNumericLiteral(timeout)) {
      if (Number.isFinite(Number(timeout.text)) && Number(timeout.text) > 0) return "bounded";
    } else if (!ts.isPrefixUnaryExpression(timeout) && timeout.kind !== ts.SyntaxKind.NullKeyword) unknown = true;
  }
  if (unknown || signal && !context.nativeSignal) return "unknown";
  if (signal && signal.kind !== ts.SyntaxKind.NullKeyword && !(ts.isIdentifier(signal) && signal.text === "undefined" && !symbolOf(signal))) return "cancellation-only";
  return "unbounded";
}

/** Absent properties inherit, null marks an unresolved effective value. */
interface DeadlineOptions { timeout?: ts.Expression | null; signal?: ts.Expression | null }
const unknownOptions = { timeout: null, signal: null };
function defaultOptions(defaults: AxiosDefaults): DeadlineOptions {
  const result: DeadlineOptions = defaults.unknown ? { ...unknownOptions } : {};
  if (defaults.timeout) result.timeout = defaults.timeout;
  if (defaults.signal) result.signal = defaults.signal;
  return result;
}

function nativeName(node: ts.Expression, name: string): boolean {
  return ts.isIdentifier(node) && node.text === name && !symbolOf(node)?.declarations?.length
    || ts.isPropertyAccessExpression(node) && node.name.text === name && ts.isIdentifier(node.expression)
      && node.expression.text === "globalThis" && !symbolOf(node.expression)?.declarations?.length;
}
function absentValue(value: ts.Expression): boolean {
  return ts.isVoidExpression(value) || ts.isIdentifier(value) && value.text === "undefined" && !symbolOf(value)?.declarations?.length;
}

class TimeoutContext {
  private readonly budget: AnalysisBudget;
  private readonly literals = new WeakMap<ts.ObjectLiteralExpression, DeadlineOptions>();
  private readonly factories = new WeakMap<ts.CallExpression, { options: DeadlineOptions; height: number }>();
  private readonly signals = new WeakMap<ts.Expression, boolean>();
  private nativeRequest?: boolean;

  constructor(private readonly workspace: Workspace, readonly nativeSignal: boolean) {
    this.budget = new AnalysisBudget("Outbound timeout options", projectWorkLimit(workspace.units.map(unit => unit.sf)));
  }

  options(value: ts.Expression | undefined): DeadlineOptions {
    if (!value) return {};
    const obj = asObject(value);
    if (!obj) return unknownOptions;
    const cached = this.literals.get(obj);
    if (cached) return cached;
    const result: DeadlineOptions = {};
    for (const p of obj.properties) {
      this.budget.take();
      if (ts.isSpreadAssignment(p) || !p.name || ts.isComputedPropertyName(p.name)) {
        result.timeout = result.signal = null;
        continue;
      }
      const name = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : "";
      if (name === "__proto__" && ts.isPropertyAssignment(p)) result.timeout = result.signal = null;
      if (name === "timeout" || name === "signal") result[name] = ts.isPropertyAssignment(p) ? p.initializer
        : ts.isShorthandPropertyAssignment(p) ? p.name : null;
    }
    this.literals.set(obj, result);
    return result;
  }

  created(create: ts.CallExpression, depth = 0): { options: DeadlineOptions; height: number } {
    this.budget.take();
    const cached = this.factories.get(create);
    if (depth + (cached?.height ?? 1) > 128) throw new AnalysisLimitError("Binding resolution depth limit exceeded");
    if (cached) return cached;
    const factory = currentImportedBinding(create.expression);
    const parent = factory && axiosInstance(factory);
    const inherited = parent ? this.created(parent, depth + 1) : undefined;
    const local = factory && axiosDefaultsAt(factory, create);
    const defaults = !local || parent && local.changed ? unknownOptions : defaultOptions(local);
    const result = { options: { ...inherited?.options, ...defaults, ...this.options(create.arguments[0]) }, height: 1 + (inherited?.height ?? 0) };
    this.factories.set(create, result);
    return result;
  }

  request(input: ts.Expression): DeadlineOptions {
    let value = input, use: ts.Node = input;
    const seen = new Set<ts.Node>();
    while (!seen.has(value)) {
      this.budget.take(); seen.add(value);
      if (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isTypeAssertionExpression(value)
        || ts.isNonNullExpression(value) || ts.isSatisfiesExpression(value)) { value = value.expression; continue; }
      if (ts.isNewExpression(value) && nativeName(value.expression, "Request")) {
        this.nativeRequest ??= this.workspace.units.every(unit => nativeRequestUnchanged(unit.sf));
        if (!this.nativeRequest) return unknownOptions;
        const { signal } = this.options(value.arguments?.[1]);
        if (signal === null || signal && !absentValue(signal)) return { signal };
        if (!value.arguments?.[0]) break;
        use = value = value.arguments[0];
        continue;
      }
      const decl = ts.isIdentifier(value) ? symbolOf(value)?.valueDeclaration : undefined;
      if (!decl || !ts.isVariableDeclaration(decl)) break;
      const captured = currentInitializer(decl, use);
      if (!captured) break;
      use = value = captured;
    }
    return {};
  }

  hasTimer(expr: ts.Expression): boolean {
    const cached = this.signals.get(expr);
    if (cached !== undefined) return cached;
    let found = false;
    const pending = [expr];
    while (pending.length && !found) {
      this.budget.take();
      const call = pending.pop()!;
      if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)
        || !nativeName(call.expression.expression, "AbortSignal")) continue;
      const value = call.arguments[0];
      if (call.expression.name.text === "timeout" && value && ts.isNumericLiteral(value)) {
        found = Number.isSafeInteger(Number(value.text)) && Number(value.text) >= 0;
      } else if (call.expression.name.text === "any" && value && ts.isArrayLiteralExpression(value)) {
        for (const element of value.elements) { this.budget.take(); if (ts.isExpression(element)) pending.push(element); }
      }
    }
    this.signals.set(expr, found);
    return found;
  }
}

function asObject(arg: ts.Expression | undefined): ts.ObjectLiteralExpression | null {
  if (!arg) return null;
  let val = arg;
  while (ts.isAsExpression(val) || ts.isParenthesizedExpression(val) || ts.isTypeAssertionExpression(val)
    || ts.isSatisfiesExpression(val) || ts.isNonNullExpression(val)) {
    val = val.expression;
  }
  return ts.isObjectLiteralExpression(val) ? val : null;
}
