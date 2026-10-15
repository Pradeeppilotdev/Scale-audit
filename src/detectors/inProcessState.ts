import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { listSourceFiles, readFileSafe, parseSource, lineOf, snippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";

export async function detectInProcessState(root: string): Promise<Finding[]> {
  const out: Finding[] = [];
  const files = await listSourceFiles(root);

  // Package-level checks (once)
  let pkg: any = {};
  try { pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")); } catch {}
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  if (deps["socket.io"] && !deps["@socket.io/redis-adapter"] && !deps["socket.io-redis"]) {
    // only flag if socket.io is actually used in code
    // (handled per-file below)
  }

  for (const rel of files) {
    const content = await readFileSafe(root, rel);
    if (!content) continue;
    const sf = parseSource(rel, content);
    if (!sf) continue;

    // express-session without store
    visitSession(sf, content, rel, out);

    // express-rate-limit usage -> memory store by default
    if (content.includes("rateLimit") || content.includes("rate-limit") || content.includes("express-rate-limit")) {
      const ln = findLine(content, /rateLimit|express-rate-limit|rate-limit/);
      if (ln) {
        out.push(
          makeFinding({
            id: "in-memory-rate-limit",
            category: "Concurrency",
            severity: "medium",
            confidence: "low",
            file: rel,
            line: ln,
            message: "Rate limiter appears to be used; default store is in-memory (not shared across instances).",
            scaleTrigger: "Rate limits reset per instance and can be bypassed behind a load balancer.",
            suggestedFix: "Configure a shared store (Redis) for express-rate-limit if running >1 instance; otherwise document single-instance constraint.",
            snippet: snippetAt(content, ln),
          }),
        );
      }
    }

    // socket.io presence (file-level)
    if (content.includes("socket.io") && (deps["socket.io"] || content.includes("require('socket.io')") || content.includes('from "socket.io"'))) {
      if (!deps["@socket.io/redis-adapter"] && !deps["socket.io-redis"]) {
        const ln = findLine(content, /socket\.io|io\(|Server\(/);
        if (ln) {
          out.push(
            makeFinding({
              id: "in-memory-websocket",
              category: "Concurrency",
              severity: "medium",
              confidence: "medium",
              file: rel,
              line: ln,
              message: "WebSocket server uses in-process state (no Redis adapter detected).",
              scaleTrigger: "Broadcasts/rooms do not propagate across instances.",
              suggestedFix: "Use @socket.io/redis-adapter (or sticky sessions + shared pub/sub) for horizontal scaling.",
              snippet: snippetAt(content, ln),
            }),
          );
        }
      }
    }

    // module-scope Map/Set caches
    detectModuleScopeState(sf, content, rel, out);
  }
  return out;
}

function visitSession(sf: ts.SourceFile, content: string, rel: string, out: Finding[]) {
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText();
      if (/\bsession\b/.test(callee)) {
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

function detectModuleScopeState(sf: ts.SourceFile, content: string, rel: string, out: Finding[]) {
  for (const stmt of sf.statements) {
    // variable statements at top level
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer) continue;
      const init = decl.initializer.getText();
      if (!/new\s+Map\(|new\s+Set\(/.test(init)) continue;
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
