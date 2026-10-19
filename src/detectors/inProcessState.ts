import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { lineOf, snippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";
import type { FileContext } from "../context.js";
import { Workspace } from "../workspace.js";

export async function detectInProcessState(root: string, ws?: Workspace): Promise<Finding[]> {
  const out: Finding[] = [];
  const workspace = ws ?? (await Workspace.load(root));

  let pkg: any = {};
  try { pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")); } catch {}
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

  for (const unit of workspace.units) {
    const { rel, content, sf, ctx } = unit;

    visitSession(sf, content, rel, ctx, out);
    visitRateLimit(sf, content, rel, ctx, out);
    visitSocketIo(sf, content, rel, deps, out);
    detectModuleScopeState(sf, content, rel, out);
  }
  return out;
}

/**
 * How confident we are that a middleware options object has no shared store.
 * "none" = the options object is visible and has no `store` key.
 * "unknown" = the options live in a variable, so we cannot tell.
 */
type StoreVerdict = "none" | "unknown" | "present";

function storeVerdict(arg: ts.Expression | undefined): StoreVerdict {
  if (!arg) return "none";
  let val = arg;
  while (ts.isAsExpression(val) || ts.isParenthesizedExpression(val) || ts.isTypeAssertionExpression(val) || ts.isNonNullExpression(val)) {
    val = (val as any).expression;
  }
  if (!ts.isObjectLiteralExpression(val)) return "unknown";
  const hasStore = val.properties.some((p) => {
    const name = (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) ? p.name.getText().replace(/['"]/g, "") : "";
    return name === "store";
  });
  return hasStore ? "present" : "none";
}

function visitSession(sf: ts.SourceFile, content: string, rel: string, ctx: FileContext, out: Finding[]) {
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText();
      const isSession =
        callee === "session" ||
        callee === "expressSession" ||
        callee === "session.default" ||
        callee.endsWith(".session") ||
        callee.endsWith(".expressSession") ||
        (ts.isIdentifier(node.expression) && ctx.sessionBindings.has(node.expression.text));
      if (isSession) {
        const verdict = storeVerdict(node.arguments[0]);
        if (verdict === "none") {
          const ln = lineOf(sf, node);
          out.push(
            makeFinding({
              id: "in-process-session",
              category: "Concurrency",
              severity: "high",
              confidence: "medium",
              file: rel,
              line: ln,
              message: "express-session configured without a `store` (defaults to in-memory MemoryStore).",
              scaleTrigger: "Sessions not shared across instances; MemoryStore is not production-safe for clusters.",
              suggestedFix: "Configure a shared session store (Redis/DB) via connect-redis or equivalent.",
              snippet: snippetAt(content, ln),
            }),
          );
        } else if (verdict === "unknown") {
          const ln = lineOf(sf, node);
          out.push(
            makeFinding({
              id: "in-process-session",
              category: "Concurrency",
              severity: "low",
              confidence: "low",
              file: rel,
              line: ln,
              message: "express-session options are passed as a variable; could not confirm a shared `store` is configured.",
              scaleTrigger: "Without a shared store, sessions live in per-instance memory and are lost on restart.",
              suggestedFix: "Verify the options object sets `store` (Redis/DB); the default is the in-memory MemoryStore.",
              snippet: snippetAt(content, ln),
            }),
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

function visitRateLimit(sf: ts.SourceFile, content: string, rel: string, ctx: FileContext, out: Finding[]) {
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText();
      const isRateLimit =
        /(^|\.)rateLimit(\.default)?$/.test(callee) ||
        /(^|\.)rate-limiter(\.default)?$/.test(callee) ||
        (ts.isIdentifier(node.expression) && ctx.rateLimitBindings.has(node.expression.text));
      if (isRateLimit) {
        const verdict = storeVerdict(node.arguments[0]);
        if (verdict === "none") {
          const ln = lineOf(sf, node);
          out.push(
            makeFinding({
              id: "in-memory-rate-limit",
              category: "Concurrency",
              severity: "medium",
              confidence: "medium",
              file: rel,
              line: ln,
              message: "rate limit middleware configured without a shared `store` (uses in-memory by default).",
              scaleTrigger: "Rate limits reset per instance and can be bypassed behind a load balancer.",
              suggestedFix: "Configure a shared store (Redis) if running more than one instance; otherwise document the single-instance constraint.",
              snippet: snippetAt(content, ln),
            }),
          );
        } else if (verdict === "unknown") {
          const ln = lineOf(sf, node);
          out.push(
            makeFinding({
              id: "in-memory-rate-limit",
              category: "Concurrency",
              severity: "low",
              confidence: "low",
              file: rel,
              line: ln,
              message: "rate limit options are passed as a variable; could not confirm a shared `store` is configured.",
              scaleTrigger: "An in-memory limiter resets per instance and can be bypassed behind a load balancer.",
              suggestedFix: "Verify the options object sets `store` (Redis) when running more than one instance.",
              snippet: snippetAt(content, ln),
            }),
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

function visitSocketIo(sf: ts.SourceFile, content: string, rel: string, deps: Record<string, string>, out: Finding[]) {
  if (deps["@socket.io/redis-adapter"] || deps["socket.io-redis"]) return;
  if (!hasSocketIoImport(sf)) return;
  let line: number | null = null;
  function visit(node: ts.Node) {
    if (line) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "io") {
      line = lineOf(sf, node);
    }
    if (ts.isNewExpression(node) && node.expression.getText() === "Server") {
      line = lineOf(sf, node);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  if (!line) return;
  out.push(
    makeFinding({
      id: "in-memory-websocket",
      category: "Concurrency",
      severity: "medium",
      confidence: "medium",
      file: rel,
      line,
      message: "WebSocket server uses in-process state (no Redis adapter detected).",
      scaleTrigger: "Broadcasts/rooms do not propagate across instances.",
      suggestedFix: "Use @socket.io/redis-adapter (or sticky sessions + shared pub/sub) for horizontal scaling.",
      snippet: snippetAt(content, line),
    }),
  );
}

function hasSocketIoImport(sf: ts.SourceFile): boolean {
  let found = false;
  function visit(node: ts.Node) {
    if (found) return;
    if (ts.isImportDeclaration(node) && node.moduleSpecifier.getText().replace(/['"]/g, "") === "socket.io") {
      found = true;
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "socket.io"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

/**
 * Module-level in-memory collections.
 *
 * A module-level `new Map()` that is only filled at import time is a constant
 * lookup table, not runtime state, so it is not reported. Only collections that
 * are mutated while the process is serving requests qualify.
 */
function detectModuleScopeState(sf: ts.SourceFile, content: string, rel: string, out: Finding[]) {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer) continue;
      const init = decl.initializer.getText();
      if (!/new\s+Map\s*(<[^>]*>)?\s*\(|new\s+Set\s*(<[^>]*>)?\s*\(/.test(init)) continue;
      const name = decl.name.getText().toLowerCase();
      if (!/(cache|session|state|store|rate|limit|book|registry|tokens)/.test(name)) continue;
      if (!isMutatedAtRuntime(decl.name.getText(), sf)) continue;
      const ln = lineOf(sf, decl);
      out.push(
        makeFinding({
          id: "in-process-state",
          category: "Concurrency",
          severity: "medium",
          confidence: "low",
          file: rel,
          line: ln,
          message: `Module-level in-memory collection "${decl.name.getText()}" used as state/cache.`,
          scaleTrigger: "State is not shared across instances/processes, and the collection grows without bound.",
          suggestedFix: "Move state to Redis/shared cache, or make the resource stateless.",
          snippet: snippetAt(content, ln),
        }),
      );
    }
  }
}

/** True when the collection is written to from inside a function body. */
function isMutatedAtRuntime(name: string, sf: ts.SourceFile): boolean {
  let mutated = false;
  const visit = (node: ts.Node) => {
    if (mutated) return;
    // Only count mutations that happen inside a function (i.e. at request time).
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression.getText();
      const method = node.expression.name.getText();
      if (receiver === name && (method === "set" || method === "add" || method === "push" || method === "delete" || method === "clear")) {
        if (isInsideFunctionBody(node)) {
          mutated = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return mutated;
}

function isInsideFunctionBody(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isGetAccessorDeclaration(cur) ||
      ts.isSetAccessorDeclaration(cur) ||
      ts.isConstructorDeclaration(cur)
    ) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}
