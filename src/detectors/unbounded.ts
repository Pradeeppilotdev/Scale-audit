import ts from "typescript";
import { lineOf, snippetAt, makeFinding, isOrmCall, hasChainedPagination, asObjectLiteral, DB_RECEIVER } from "./common.js";
import type { Finding } from "../types.js";
import type { FileContext } from "../context.js";
import { Workspace } from "../workspace.js";

const UNIQUE_METHODS = new Set(["findUnique", "findUniqueOrThrow", "findOne", "findByPk", "findByID", "findById", "findFirst", "findFirstOrThrow"]);

/**
 * Aggregates are bounded by construction: `count()`, `aggregate()` and
 * `groupBy()` return a number or one row per group, never the whole table.
 */
const AGGREGATE_METHODS = new Set(["aggregate", "count", "countBy", "groupBy", "exists", "sum", "avg", "min", "max", "distinct"]);

const PAGINATION_KEYS = new Set(["take", "limit", "skip", "cursor", "top", "first", "pageSize", "perPage", "offset", "start", "end"]);

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
      if (isOrmCall(node, ctx) && !UNIQUE_METHODS.has(methodName) && !AGGREGATE_METHODS.has(methodName) && !isBuilderOnly(node)) {
        const check = paginationCheck(node);
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
  return template.getText();
}

function sqlText(arg: ts.Expression): string | null {
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) return arg.getText();
  return null;
}

function hasSqlLimit(sql: string): boolean {
  return /\blimit\b/i.test(sql) || /\btop\s+\d+\b/i.test(sql) || /\bfetch\s+first\b/i.test(sql);
}

type PaginationCheck = "bounded" | "unbounded" | "unknown";

function paginationCheck(node: ts.CallExpression): PaginationCheck {
  if (hasChainedPagination(node)) return "bounded";
  if (node.arguments.length === 0) return "unbounded";

  let sawObject = false;
  let sawScalarString = false;
  let sawUnverifiable = false;

  // Inspect every argument: Mongoose puts options in the 3rd arg, Prisma in the 1st.
  for (const arg of node.arguments) {
    if (ts.isObjectLiteralExpression(arg)) {
      sawObject = true;
      const hasKey = arg.properties.some((p) => {
        if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
          const name = p.name.getText().replace(/['"]/g, "");
          return PAGINATION_KEYS.has(name);
        }
        return false;
      });
      if (hasKey) return "bounded";
    } else if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) || ts.isTemplateExpression(arg)) {
      sawScalarString = true;
      if (/limit/i.test(arg.getText())) return "bounded";
    } else {
      sawUnverifiable = true;
    }
  }

  // Object args with no pagination key -> confidently unbounded.
  if (sawObject) return "unbounded";
  // Only opaque variables/spreads -> can't tell, do not assert unbounded.
  if (sawUnverifiable) return "unknown";
  // Only string/SQL arguments without LIMIT -> unbounded.
  if (sawScalarString) return "unbounded";
  return "unbounded";
}
