import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { listSourceFiles, readFileSafe, parseSource, lineOf, snippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";

export async function detectInProcessState(root: string): Promise<Finding[]> {
  const out: Finding[] = [];
  const files = await listSourceFiles(root);

  let pkg: any = {};
  try { pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")); } catch {}
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

  for (const rel of files) {
    const content = await readFileSafe(root, rel);
    if (!content) continue;
    const sf = parseSource(rel, content);
    if (!sf) continue;

    visitSession(sf, content, rel, out);
    visitRateLimit(sf, content, rel, out);
    visitSocketIo(sf, content, rel, deps, out);
    detectModuleScopeState(sf, content, rel, out);
  }
  return out;
}

function visitSession(sf: ts.SourceFile, content: string, rel: string, out: Finding[]) {
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText();
      const isSession =
        callee === "session" ||
        callee === "expressSession" ||
        callee === "session.default" ||
        callee.endsWith(".session") ||
        callee.endsWith(".expressSession");
      if (isSession) {
        let arg = node.arguments[0];
        while (arg && (ts.isAsExpression(arg) || ts.isParenthesizedExpression(arg) || ts.isTypeAssertionExpression(arg))) {
          arg = (arg as any).expression;
        }
        if (arg && ts.isObjectLiteralExpression(arg)) {
          const hasStore = arg.properties.some((p) => {
            const name = (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) ? p.name.getText().replace(/['"]/g, "") : "";
            return name === "store";
          });
          if (!hasStore) {
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
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

function visitRateLimit(sf: ts.SourceFile, content: string, rel: string, out: Finding[]) {
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText();
      const isRateLimit = /(^|\.)rateLimit(\.default)?$/.test(callee) || /(^|\.)rate-limiter(\.default)?$/.test(callee);
      if (isRateLimit) {
        let arg = node.arguments[0];
        while (arg && (ts.isAsExpression(arg) || ts.isParenthesizedExpression(arg) || ts.isTypeAssertionExpression(arg))) {
          arg = (arg as any).expression;
        }
        let hasStore = false;
        if (arg && ts.isObjectLiteralExpression(arg)) {
          hasStore = arg.properties.some((p) => {
            const name = (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) ? p.name.getText().replace(/['"]/g, "") : "";
            return name === "store";
          });
        }
        if (!hasStore) {
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

function detectModuleScopeState(sf: ts.SourceFile, content: string, rel: string, out: Finding[]) {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer) continue;
      const init = decl.initializer.getText();
      if (!/new\s+Map\s*(<[^>]*>)?\s*\(|new\s+Set\s*(<[^>]*>)?\s*\(/.test(init)) continue;
      const name = decl.name.getText().toLowerCase();
      if (!/(cache|session|state|store|rate|limit|book|registry|tokens)/.test(name)) continue;
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
          scaleTrigger: "State is not shared across instances/processes.",
          suggestedFix: "Move state to Redis/shared cache or make the resource stateless.",
          snippet: snippetAt(content, ln),
        }),
      );
    }
  }
}

function findLine(content: string, re: RegExp): number | null {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i + 1;
  }
  return null;
}
