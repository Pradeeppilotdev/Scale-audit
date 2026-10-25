import ts from "typescript";
import { lineOf, snippetAt, makeFinding, isOrmCall, chainedPagination, asObjectLiteral, DB_RECEIVER, isKnownModel } from "./common.js";
import type { Finding } from "../types.js";
import type { FileContext } from "../context.js";
import { Workspace } from "../workspace.js";

const UNIQUE_METHODS = new Set(["findUnique", "findUniqueOrThrow", "findOne", "findByPk", "findByID", "findById", "findFirst", "findFirstOrThrow"]);

/**
 * Scalar aggregates are bounded; groupBy and aggregation pipelines can return
 * one result per input record and still need a result cap.
 */
const AGGREGATE_METHODS = new Set(["count", "countBy", "exists", "sum", "avg", "min", "max"]);

const PAGINATION_KEYS = new Set(["take", "limit", "top", "first", "pageSize", "perPage"]);

export async function detectUnboundedReads(root: string, ws?: Workspace): Promise<Finding[]> {
  const out: Finding[] = [];
  const workspace = ws ?? (await Workspace.load(root));
  for (const unit of workspace.units) {
    visit(unit.sf, unit.content, unit.rel, unit.ctx, out);
  }
  return out;
}

function visit(sf: ts.SourceFile, content: string, rel: string, ctx: FileContext, out: Finding[]): void {
  visitNode(sf, sf, content, rel, ctx, out);
}

function visitNode(node: ts.Node, sf: ts.SourceFile, content: string, rel: string, ctx: FileContext, out: Finding[]): void {
  const raw = rawQueryInfo(node);
  if (raw) {
    // Prisma $queryRaw / knex .raw(): the SQL is in the call, so we can check for LIMIT.
    if (!hasSqlLimit(raw.sql)) {
      const ln = lineOf(sf, node);
      out.push(
        makeFinding({
          id: "unbounded-raw-query",
          category: "DB",
          severity: "high",
          confidence: "high",
          file: rel,
          line: ln,
          message: `Raw SQL query via ${raw.name} has no LIMIT clause; it can return the full table.`,
          scaleTrigger: "Unbounded raw SQL reads the whole table into memory and locks rows as the table grows.",
          suggestedFix: "Add a LIMIT/ORDER BY + cursor window, and make sure the query is served by an index.",
          snippet: snippetAt(content, ln),
        }),
      );
    }
  } else if (ts.isCallExpression(node)) {
    const clientQuery = rawClientQuery(node);
    if (clientQuery) {
      // `client.query({ text: sql })` where the SQL is a variable: we cannot tell
      // whether it is bounded, so we do not assert that it is unbounded.
      if (clientQuery.sql === null) {
        const ln = lineOf(sf, node);
        out.push(
          makeFinding({
            id: "unbounded-read",
            category: "DB",
            severity: "medium",
            confidence: "low",
            file: rel,
            line: ln,
            message: "Raw SQL query text is built at runtime; could not confirm it has a LIMIT clause.",
            scaleTrigger: "An unbounded raw query reads the whole table into memory as the data grows.",
            suggestedFix: "Make sure the SQL always includes a LIMIT/parameterised page size.",
            snippet: snippetAt(content, ln),
          }),
        );
      } else if (!hasSqlLimit(clientQuery.sql)) {
        const ln = lineOf(sf, node);
        out.push(
          makeFinding({
            id: "unbounded-raw-query",
            category: "DB",
            severity: "high",
            confidence: "high",
            file: rel,
            line: ln,
            message: "Raw SQL query has no LIMIT clause; it can return the full table.",
            scaleTrigger: "Unbounded raw SQL reads the whole table into memory and locks rows as the table grows.",
            suggestedFix: "Add a LIMIT/ORDER BY + cursor window, and make sure the query is served by an index.",
            snippet: snippetAt(content, ln),
          }),
        );
      }
    } else {
      const methodName = methodNameOf(node.expression);
      if (isOrmCall(node, ctx) && !UNIQUE_METHODS.has(methodName) && !AGGREGATE_METHODS.has(methodName) && !(methodName === "aggregate" && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) && !isBuilderOnly(node)) {
        const check = paginationCheck(node, ctx);
        if (check !== "bounded") {
          const unknown = check === "unknown";
          const ln = lineOf(sf, node);
          out.push(
            makeFinding({
              id: "unbounded-read",
              category: "DB",
              severity: unknown ? "medium" : "high",
              confidence: unknown ? "low" : "medium",
              file: rel,
              line: ln,
              message: unknown
                ? `Database read "${methodName}" could not be confirmed as paginated (query passed as a variable); verify take/limit/cursor is set.`
                : `Database read "${methodName}" appears to have no pagination (take/limit/cursor/skip).`,
              scaleTrigger: "Returns the full table/collection; memory and latency grow with data size.",
              suggestedFix: "Add bounded pagination (take + cursor/skip) with a sensible default cap and enforce max page size.",
              snippet: snippetAt(content, ln),
            }),
          );
        }
      }
    }
  }
  ts.forEachChild(node, (c) => visitNode(c, sf, content, rel, ctx, out));
}

/**
 * `client.query("SELECT ...")` / `client.query({ text: "SELECT ..." })`.
 *
 * The SQL may be a runtime value, in which case the pagination is unknown.
 */
function rawClientQuery(node: ts.CallExpression): { sql: string | null } | null {
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  const method = node.expression.name.getText();
  if (method !== "query" && method !== "execute") return null;
  const receiver = node.expression.expression.getText();
  if (!/(^|\.)client$/.test(receiver)) return null;

  const arg = node.arguments[0];
  if (!arg) return { sql: null };

  // client.query("SELECT ...")
  const direct = sqlText(arg);
  if (direct !== null) return { sql: direct };

  // client.query({ text: "SELECT ..." })
  const obj = asObjectLiteral(arg);
  if (obj) {
    let hasText = false;
    let hasQuery = false;
    let textValue: string | null = null;
    for (const p of obj.properties) {
      if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue;
      const name = p.name.getText().replace(/['"]/g, "");
      if (name === "text") {
        hasText = true;
        if (ts.isPropertyAssignment(p)) textValue = sqlText(p.initializer);
      }
      if (name === "query") hasQuery = true;
    }
    // `{ query: gql\`...\` }` is a GraphQL document, not SQL.
    if (hasQuery && !hasText) return null;
    if (hasText) return { sql: textValue };
    return null;
  }
  return { sql: null };
}

/**
 * Query-builder methods (`select`, `from`, `where`) are not reads by
 * themselves; only the completed chain is. A `select()` that is never part of
 * a chain is not a database read we can reason about.
 */
const BUILDER_METHODS = new Set(["from", "where", "join", "leftJoin", "innerJoin", "rightJoin", "orderBy", "groupBy", "having", "limit", "offset", "take", "skip", "returning"]);

function isBuilderOnly(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const method = node.expression.name.getText();
  if (method !== "select") return false;
  // Only a `select()` that continues into a builder chain is a query.
  let cur: ts.Node = node;
  while (cur.parent) {
    const p = cur.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === cur) {
      if (BUILDER_METHODS.has(p.name.getText())) return false;
      cur = p;
      continue;
    }
    if (ts.isCallExpression(p) && p.expression === cur) {
      cur = p;
      continue;
    }
    break;
  }
  return true;
}

function methodNameOf(expr: ts.Expression): string {
  if (ts.isPropertyAccessExpression(expr)) return expr.name.getText();
  if (ts.isIdentifier(expr)) return expr.text;
  return "";
}

interface RawQuery {
  name: string;
  sql: string;
}

/**
 * Detect raw-SQL entry points whose SQL text is available statically.
 *
 * `prisma.$queryRaw` is a tagged template, not a call expression, so both
 * shapes have to be handled.
 *
 * A method called `raw` is only raw SQL when it hangs off a database-ish
 * receiver *and* the text actually looks like SQL. Plenty of libraries export
 * an unrelated `raw()` helper.
 */
function rawQueryInfo(node: ts.Node): RawQuery | null {
  if (ts.isTaggedTemplateExpression(node)) {
    const tag = node.tag;
    const name = ts.isPropertyAccessExpression(tag) ? tag.name.getText() : ts.isIdentifier(tag) ? tag.text : "";
    const receiver = ts.isPropertyAccessExpression(tag) ? tag.expression.getText() : "";
    const isPrismaRaw = /^\$(query|execute)Raw/.test(name);
    const isSqlTag = name === "sql";
    if (!isPrismaRaw && !isSqlTag) return null;
    if (!isPrismaRaw && receiver && !DB_RECEIVER.test(receiver)) return null;
    const sql = templateText(node.template);
    if (sql === null || !looksLikeSql(sql)) return null;
    return { name: isPrismaRaw ? name : receiver || name, sql };
  }

  if (!ts.isCallExpression(node)) return null;
  if (!ts.isPropertyAccessExpression(node.expression)) return null;

  const methodName = methodNameOf(node.expression);
  const receiver = node.expression.expression.getText();

  // Prisma $queryRaw`...` / $queryRawUnsafe("...")
  if (/^\$(query|execute)Raw/.test(methodName)) {
    const arg = node.arguments[0];
    if (!arg) return null;
    const sql = sqlText(arg);
    if (sql === null || !looksLikeSql(sql)) return null;
    return { name: methodName, sql };
  }
  // knex.raw("SELECT ..."), db.raw(`...`)
  if (methodName === "raw" || methodName === "queryRaw") {
    if (!DB_RECEIVER.test(receiver)) return null;
    const arg = node.arguments[0];
    if (!arg) return null;
    const sql = sqlText(arg);
    if (sql === null || !looksLikeSql(sql)) return null;
    return { name: methodName, sql };
  }
  return null;
}

/** True when the text plausibly is a SQL statement. */
function looksLikeSql(sql: string): boolean {
  return /\b(select|insert\s+into|update|delete\s+from|with)\b/i.test(sql);
}

function templateText(template: ts.TemplateExpression | ts.NoSubstitutionTemplateLiteral): string | null {
  if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text;
  return template.head.text + template.templateSpans.map(span => " ? " + span.literal.text).join("");
}

function sqlText(arg: ts.Expression): string | null {
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) return templateText(arg);
  return null;
}

/** Ignore SQL comments, quoted literals and nested subquery limits. */
function hasSqlLimit(sql: string): boolean {
  let clean = "";
  for (let i = 0; i < sql.length;) {
    if (sql.startsWith("--", i)) { const end = sql.indexOf("\n", i); i = end < 0 ? sql.length : end; clean += " "; continue; }
    if (sql.startsWith("/*", i)) {
      let nested = 1; i += 2;
      while (i < sql.length && nested) {
        if (sql.startsWith("/*", i)) { nested++; i += 2; }
        else if (sql.startsWith("*/", i)) { nested--; i += 2; }
        else i++;
      }
      clean += " "; continue;
    }
    const quote = sql[i];
    if (quote === "'" || quote === '"' || quote === "`") {
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) { i++; if (sql[i] === quote) { i++; continue; } break; }
        if (sql[i] === "\\") i++;
        i++;
      }
      clean += " quoted_value "; continue;
    }
    const dollar = /^\$(?:[a-zA-Z_]\w*)?\$/.exec(sql.slice(i));
    if (dollar) { const end = sql.indexOf(dollar[0], i + dollar[0].length); i = end < 0 ? sql.length : end + dollar[0].length; clean += " quoted_value "; continue; }
    clean += sql[i++];
  }
  let depth = 0;
  let top = "";
  for (const char of clean) {
    if (char === "(") { if (depth === 0) top += " () "; depth++; }
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) top += char;
  }
  return top.split(";").filter(statement => statement.trim()).every(statement => {
    const select = /\bselect\b/i.exec(statement);
    if (!select) return !/\breturning\b/i.test(statement);
    const query = statement.slice(select.index);
    if (!/\b(?:group\s+by|union|intersect|except)\b/i.test(query) && /^select\s+(?:count|sum|avg|min|max)\s*\(\)\s*(?:as\s+\w+\s*)?(?:from\b|$)/i.test(query)) return true;
    return /\blimit\s+(?:\d+|\$\d+|\?)/i.test(query) || /\btop\s+\d+\b/i.test(query) || /\bfetch\s+(?:first|next)\s+\d+/i.test(query);
  });
}

type PaginationCheck = "bounded" | "unbounded" | "unknown";

function paginationCheck(node: ts.CallExpression, ctx: FileContext): PaginationCheck {
  const chain = chainedPagination(node);
  if (chain) return chain;
  const method = methodNameOf(node.expression);
  // find() filters are not option objects. Mongoose uses argument three;
  // MongoDB uses argument two. Prisma/Sequelize use argument one.
  const receiver = ts.isPropertyAccessExpression(node.expression) ? node.expression.expression.getText() : "";
  const mongooseModel = isKnownModel(receiver, ctx) && !ctx.imports.has("typeorm");
  const optionIndex = method === "find" ? mongooseModel ? 2 : ctx.imports.has("typeorm") ? 0 : 1 : 0;
  const config = node.arguments[optionIndex];
  if (!config || config.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(config) && config.text === "undefined")) return "unbounded";
  if (!ts.isObjectLiteralExpression(config)) return "unknown";
  const effective = new Map<string, ts.Expression>();
  let unknown = false;
  for (const property of config.properties) {
    if (ts.isSpreadAssignment(property) || (property.name && ts.isComputedPropertyName(property.name))) {
      effective.clear(); unknown = true; continue;
    }
    if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
      const name = property.name.getText().replace(/['"]/g, "");
      if (PAGINATION_KEYS.has(name)) effective.set(name, ts.isPropertyAssignment(property) ? property.initializer : property.name);
    }
  }
  for (const value of effective.values()) {
    if (ts.isNumericLiteral(value)) { if (Number(value.text) > 0) return "bounded"; }
    else if (value.kind !== ts.SyntaxKind.NullKeyword && !(ts.isIdentifier(value) && value.text === "undefined")) unknown = true;
  }
  return unknown ? "unknown" : "unbounded";
}
