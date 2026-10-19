import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { lineOf, snippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";
import { Workspace } from "../workspace.js";

const HEALTH_PATH = /^\/(?:api\/)?(health|healthz|live|ready|readiness)(?:\/|$)/i;
const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "use", "route", "head", "options"]);

export async function detectLifecycle(root: string, ws?: Workspace): Promise<Finding[]> {
  const out: Finding[] = [];

  let pkg: any = {};
  try { pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")); } catch {}
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const hasServerFramework = Boolean(deps.express || deps.fastify || deps["@nestjs/core"] || deps.koa || deps["@hapi/hapi"] || deps.next);

  const workspace = ws ?? (await Workspace.load(root));
  let serverFile: { rel: string; content: string; line: number } | null = null;
  let hasHealthRoute = false;
  let hasShutdownHandler = false;

  for (const { rel, content, sf } of workspace.units) {
    if (!hasHealthRoute && fileHasHealthRoute(sf)) hasHealthRoute = true;
    if (!hasShutdownHandler && fileHasShutdownHandler(sf)) hasShutdownHandler = true;
    if (!serverFile) {
      const listen = findListenCall(sf);
      if (listen) serverFile = { rel, content, line: listen };
    }
  }

  if (serverFile && !hasHealthRoute && hasServerFramework) {
    out.push(
      makeFinding({
        id: "missing-health-endpoint",
        category: "Observability",
        severity: "low",
        confidence: "medium",
        file: serverFile.rel,
        line: serverFile.line,
        message: "No health/liveness endpoint found in the repo.",
        scaleTrigger: "Load balancers/orchestrators cannot detect unhealthy instances, causing bad traffic routing during incidents.",
        suggestedFix: "Add GET /health (liveness) and GET /ready (readiness) with a cheap DB/queue check for readiness.",
        snippet: snippetAt(serverFile.content, serverFile.line),
      }),
    );
  }

  if (serverFile && !hasShutdownHandler) {
    out.push(
      makeFinding({
        id: "missing-graceful-shutdown",
        category: "Resilience",
        severity: "medium",
        confidence: "medium",
        file: serverFile.rel,
        line: serverFile.line,
        message: "Server does not handle SIGTERM/SIGINT for graceful shutdown.",
        scaleTrigger: "On deploys/scale-down, in-flight requests fail and DB/connection cleanup is skipped.",
        suggestedFix: "Handle SIGTERM: stop accepting connections, drain in-flight requests with a timeout, then close DB/queue clients.",
        snippet: snippetAt(serverFile.content, serverFile.line),
      }),
    );
  }

  return out;
}

/** `.listen(...)` on an app/server, or `createServer(...)`. */
function findListenCall(sf: ts.SourceFile): number | null {
  let line: number | null = null;
  function visit(node: ts.Node) {
    if (line) return;
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isPropertyAccessExpression(expr) && expr.name.getText() === "listen") {
        // `emitter.listen("event")` and `queue.listen()` are not HTTP servers.
        if (isServerReceiver(expr.expression.getText())) {
          line = lineOf(sf, node);
          return;
        }
      }
      if (ts.isIdentifier(expr) && (expr.text === "createServer" || expr.text === "createHttpsServer")) {
        line = lineOf(sf, node);
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return line;
}

/**
 * Receivers that are plausibly an HTTP server.
 *
 * `app.listen(3000)` is the server; `emitter.listen("data")` is not. Matching
 * the whole receiver name avoids flagging unrelated `.listen(...)` calls and
 * then reporting "missing health endpoint" against the wrong file.
 */
const SERVER_RECEIVER = /^(app|server|srv|http_?server|https_?server|fastify|api|backend|instance|node)$/i;

function isServerReceiver(receiverText: string): boolean {
  const parts = receiverText.split(".");
  const last = parts[parts.length - 1];
  if (!last) return false;
  return SERVER_RECEIVER.test(last);
}

/** Route registration like app.get("/health", ...) or NestJS @Get("health"). */
function fileHasHealthRoute(sf: ts.SourceFile): boolean {
  let found = false;
  function checkPathArg(node: ts.CallExpression): boolean {
    const first = node.arguments[0];
    return Boolean(first && isPathLiteral(first) && HEALTH_PATH.test(pathText(first)));
  }
  function visit(node: ts.Node) {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isPropertyAccessExpression(expr) && ROUTE_METHODS.has(expr.name.getText()) && checkPathArg(node)) {
        found = true;
        return;
      }
      // NestJS decorators: @Get("health"), @Controller("health")
      if (ts.isIdentifier(expr) && /^(Get|Head|All)$/.test(expr.text) && checkPathArg(node)) {
        found = true;
        return;
      }
      if (ts.isIdentifier(expr) && expr.text === "Controller" && checkPathArg(node)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

/** process.on("SIGTERM"|"SIGINT", ...) or NestJS enableShutdownHooks(). */
function fileHasShutdownHandler(sf: ts.SourceFile): boolean {
  let found = false;
  function visit(node: ts.Node) {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      const calleeText = expr.getText();
      if (/^process\.(on|once)$/.test(calleeText)) {
        const first = node.arguments[0];
        if (first && isPathLiteral(first) && /^(SIGTERM|SIGINT)$/.test(pathText(first))) {
          found = true;
          return;
        }
      }
      if (ts.isIdentifier(expr) && expr.text === "enableShutdownHooks") {
        found = true;
        return;
      }
      if (ts.isPropertyAccessExpression(expr) && expr.name.getText() === "enableShutdownHooks") {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

function isPathLiteral(node: ts.Expression): boolean {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function pathText(node: ts.Expression): string {
  return node.getText().replace(/^["'`]|["'`]$/g, "");
}
