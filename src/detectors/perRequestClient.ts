import ts from "typescript";
import { lineOf, snippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";
import { Workspace } from "../workspace.js";
import { isRequestPath } from "./syncIo.js";

/**
 * Clients created per request.
 *
 * `new PrismaClient()` inside a request handler creates a brand new connection
 * pool on every request. PostgreSQL's default `max_connections` is 100, so a
 * modest amount of traffic exhausts the connection pool and every request starts
 * failing. This is invisible in development (one user, one request) and is one
 * of the most common causes of "it worked yesterday and now everything times out".
 */
const CLIENT_CONSTRUCTORS = new Set([
  "PrismaClient",
  "Pool",
  "Client",
  "Redis",
  "RedisClient",
  "ioredis",
  "MongoClient",
  "Sequelize",
  "DataSource",
  "Knex",
  "createPool",
  "createClient",
  "createConnection",
]);

export async function detectPerRequestClients(root: string, ws?: Workspace): Promise<Finding[]> {
  const out: Finding[] = [];
  const workspace = ws ?? (await Workspace.load(root));

  for (const { rel, content, sf } of workspace.units) {
    const requestPath = isRequestPath(rel);
    visit(sf, sf, content, rel, requestPath, out);
  }
  return out;
}

function visit(node: ts.Node, sf: ts.SourceFile, content: string, rel: string, requestPath: boolean, out: Finding[]): void {
  if (ts.isNewExpression(node)) {
    const name = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.getText() : "";
    if (CLIENT_CONSTRUCTORS.has(name)) {
      const insideFunction = isInsideFunction(node);
      if (insideFunction && !isSingletonPattern(node)) {
        const ln = lineOf(sf, node);
        out.push(
          makeFinding({
            id: "per-request-client",
            category: "Connection",
            severity: requestPath ? "high" : "medium",
            confidence: requestPath ? "medium" : "low",
            file: rel,
            line: ln,
            message: `"new ${name}()" is created inside a function; each call opens a new connection pool.`,
            scaleTrigger:
              "Every request opens fresh database/Redis connections. Postgres defaults to 100 connections, so traffic exhausts the pool and requests start timing out.",
            suggestedFix: "Create the client once at module scope and reuse it, or inject it as a singleton.",
            snippet: snippetAt(content, ln),
          }),
        );
      }
    }
  }
  ts.forEachChild(node, (c) => visit(c, sf, content, rel, requestPath, out));
}

/**
 * True when the client is created once and reused.
 *
 * A dependency-injection container constructs a service once per application,
 * and a lazily initialised field (`this.client = new Client()`) is a singleton
 * too. Both are correct; only a client created per call is a problem.
 */
function isSingletonPattern(node: ts.Node): boolean {
  // Inside a constructor.
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isConstructorDeclaration(cur)) return true;
    if (ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur) || ts.isArrowFunction(cur)) {
      // Keep walking: a constructor may be nested in a class expression.
      cur = cur.parent;
      continue;
    }
    cur = cur.parent;
  }

  // Assigned to a class field: `this.client = new Client()`.
  const parent = node.parent;
  if (
    parent &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(parent.left) &&
    parent.left.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    return true;
  }
  return false;
}

function isInsideFunction(node: ts.Node): boolean {
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
