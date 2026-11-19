import ts from "typescript";
import { AnalysisBudget, AnalysisLimitError } from "../analysisBudget.js";
import { locationOf, sourceSnippetAt, makeFinding, isOrmCall, chainedPagination, asObjectLiteral, DB_RECEIVER, isKnownModel, isPostgresClient } from "./common.js";
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
    visit(unit.sf, unit.rel, unit.ctx, out);
  }
  return out;
}

function visit(sf: ts.SourceFile, rel: string, ctx: FileContext, out: Finding[]): void {
  visitNode(sf, sf, rel, ctx, out);
}

function visitNode(node: ts.Node, sf: ts.SourceFile, rel: string, ctx: FileContext, out: Finding[]): void {
  const raw = rawQueryInfo(node);
  if (raw) {
    // Prisma $queryRaw / knex .raw(): the SQL is in the call, so we can check for LIMIT.
    if (!hasSqlLimit(raw.sql)) {
      const { line: ln, column } = locationOf(sf, node);
      out.push(
        makeFinding({
          id: "unbounded-raw-query",
          category: "DB",
          severity: "high",
          confidence: "high",
          file: rel,
          line: ln,
          column,
          message: `Raw SQL query via ${raw.name} has no LIMIT clause; it can return the full table.`,
          scaleTrigger: "Unbounded raw SQL reads the whole table into memory and locks rows as the table grows.",
          suggestedFix: "Add a LIMIT/ORDER BY + cursor window, and make sure the query is served by an index.",
          snippet: sourceSnippetAt(sf, ln),
        }),
      );
    }
  } else if (ts.isCallExpression(node)) {
    const clientQuery = rawClientQuery(node);
    if (clientQuery) {
      // `client.query({ text: sql })` where the SQL is a variable: we cannot tell
      // whether it is bounded, so we do not assert that it is unbounded.
      if (clientQuery.sql === null) {
        const { line: ln, column } = locationOf(sf, node);
        out.push(
          makeFinding({
            id: "unbounded-read",
            category: "DB",
            severity: "medium",
            confidence: "low",
            file: rel,
            line: ln,
            column,
            message: "Raw SQL query text is built at runtime; could not confirm it has a LIMIT clause.",
            scaleTrigger: "An unbounded raw query reads the whole table into memory as the data grows.",
            suggestedFix: "Make sure the SQL always includes a LIMIT/parameterised page size.",
            snippet: sourceSnippetAt(sf, ln),
          }),
        );
      } else if (!hasSqlLimit(clientQuery.sql)) {
        const { line: ln, column } = locationOf(sf, node);
        out.push(
          makeFinding({
            id: "unbounded-raw-query",
            category: "DB",
            severity: "high",
            confidence: "high",
            file: rel,
            line: ln,
            column,
            message: "Raw SQL query has no LIMIT clause; it can return the full table.",
            scaleTrigger: "Unbounded raw SQL reads the whole table into memory and locks rows as the table grows.",
            suggestedFix: "Add a LIMIT/ORDER BY + cursor window, and make sure the query is served by an index.",
            snippet: sourceSnippetAt(sf, ln),
          }),
        );
      }
    } else {
      const methodName = methodNameOf(node.expression);
      if (isOrmCall(node, ctx) && !UNIQUE_METHODS.has(methodName) && !AGGREGATE_METHODS.has(methodName) && !(methodName === "aggregate" && node.arguments[0] && asObjectLiteral(node.arguments[0])) && !isBuilderOnly(node)) {
        const check = paginationCheck(node, ctx);
        if (check !== "bounded") {
          const unknown = check === "unknown";
          const { line: ln, column } = locationOf(sf, node);
          out.push(
            makeFinding({
              id: "unbounded-read",
              category: "DB",
              severity: unknown ? "medium" : "high",
              confidence: unknown ? "low" : "medium",
              file: rel,
              line: ln,
              column,
              message: unknown
                ? `Database read "${methodName}" could not be confirmed as paginated (query passed as a variable); verify take/limit/cursor is set.`
                : `Database read "${methodName}" appears to have no pagination (take/limit/cursor/skip).`,
              scaleTrigger: "Returns the full table/collection; memory and latency grow with data size.",
              suggestedFix: "Add bounded pagination (take + cursor/skip) with a sensible default cap and enforce max page size.",
              snippet: sourceSnippetAt(sf, ln),
            }),
          );
        }
      }
    }
  }
  ts.forEachChild(node, (c) => visitNode(c, sf, rel, ctx, out));
}

/**
 * `client.query("SELECT ...")` / `client.query({ text: "SELECT ..." })`.
 *
 * The SQL may be a runtime value, in which case the pagination is unknown.
 */
function rawClientQuery(node: ts.CallExpression): { sql: string | null } | null {
  const member = node.expression;
  if (!ts.isPropertyAccessExpression(member) && !ts.isElementAccessExpression(member)) return null;
  const method = ts.isPropertyAccessExpression(member) ? member.name.text
    : ts.isStringLiteralLike(member.argumentExpression) ? member.argumentExpression.text : undefined;
  if (method !== "query" && method !== "execute") return null;
  if (!/(^|\.)client$/.test(member.expression.getText()) && !(method === "query" && isPostgresClient(member.expression))) return null;

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
      if (ts.isSpreadAssignment(p) || p.name && ts.isComputedPropertyName(p.name)) {
        // An unknown later property can replace text. A later explicit text
        // assignment can still restore a statically known query.
        textValue = null;
        continue;
      }
      const name = p.name?.getText().replace(/['"]/g, "");
      if (name === "text") {
        hasText = true;
        textValue = ts.isPropertyAssignment(p) ? sqlText(p.initializer) : null;
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
  while (ts.isParenthesizedExpression(arg) || ts.isAsExpression(arg) || ts.isTypeAssertionExpression(arg)
    || ts.isNonNullExpression(arg) || ts.isSatisfiesExpression(arg)) arg = arg.expression;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) return templateText(arg);
  return null;
}

// Internal IDs preserve the identity of delimited names without exposing their
// contents to keyword matching. The CTE proof only runs on NUL-free SQL input.
const sqlName = "(?:[a-z_][a-z0-9_$]*|\\x00q\\d+\\x00)";
const columnName = sqlName + "(?:\\s*\\.\\s*" + sqlName + ")?";
const sqlAlias = "(?:\\s+(?:as\\s+)?" + sqlName + ")?";
const cteColumn = new RegExp("^(?:\\*|" + sqlName + "\\s*\\.\\s*\\*|" + columnName + sqlAlias + ")$", "i");
const cteFrom = new RegExp("^(" + sqlName + ")" + sqlAlias + "$", "i");
const operand = "(?:" + columnName + "|[+-]?\\d+(?:\\.\\d+)?|\\?|\\$\\d+)";
const ctePredicate = new RegExp("^(?:not\\s+)?" + operand + "(?:\\s*(?:<>|!=|<=|>=|=|<|>)\\s*" + operand
  + "|\\s+is\\s+(?:not\\s+)?null)?$", "i");
const orderColumn = new RegExp("^" + columnName + "(?:\\s+(?:asc|desc))?(?:\\s+nulls\\s+(?:first|last))?$", "i");
const concreteLimit = /\blimit\s+\d+\s*(?:(?:,\s*\d+|offset\s+(?:\d+|\$\d+|\?))\s*)?$|\bfetch\s+(?:first|next)\s+\d+\s+rows?\s+only\s*$/i;

/** Direct columns, a single source and simple filters/order can emit at most
 * one row per input. Functions, joins and dialect-specific clauses need their own proof. */
function directCteSource(branch: string, budget: AnalysisBudget): string | undefined {
  budget.take(branch.length);
  const select = /^\s*select\s+(?:(?:all|distinct)\s+)?/i.exec(branch);
  const from = /\bfrom\s+/i.exec(branch);
  if (!select || !from || from.index < select[0].length) return undefined;
  const columns = branch.slice(select[0].length, from.index).split(",");
  if (!columns.every(item => cteColumn.test(item.trim()))) return undefined;
  const clauses = branch.slice(from.index + from[0].length).split(/\s+(where|order\s+by)\s+/i);
  const source = cteFrom.exec(clauses[0].trim())?.[1].toLowerCase();
  // A single-quoted literal is masked as quoted_value and has no table identity.
  if (!source || source === "quoted_value") return undefined;
  let index = 1;
  if (clauses[index]?.toLowerCase() === "where") {
    if (!clauses[index + 1].split(/\s+(?:and|or)\s+/i).every(test => ctePredicate.test(test.trim()))) return undefined;
    index += 2;
  }
  if (clauses[index] && /^order\s+by$/i.test(clauses[index])) {
    if (!clauses[index + 1].split(",").every(order => orderColumn.test(order.trim()))) return undefined;
    index += 2;
  }
  return index === clauses.length ? source : undefined;
}

interface CteBody { text?: string; order: number; bounded?: boolean }

/** The parentheses map identifies the actual body of each declaration in the
 * flattened statement. A same-named table in a different statement is unrelated. */
function cteScope(statement: string, offset: number, groups: ReadonlyMap<number, string>, budget: AnalysisBudget):
{ main: number; definitions?: Map<string, CteBody> } | undefined {
  const definitions = new Map<string, CteBody>();
  const start = /^\s*with\s+(?:(recursive)\s+)?/i.exec(statement);
  if (!start) return undefined;
  let known = !start[1];
  const header = new RegExp("(" + sqlName + ")\\s*(?:\\((?:args)?\\)\\s*)?as\\s*(?:(?:not\\s+)?materialized\\s*)?(\\((?:args)?\\))", "iy");
  const separator = /\s*,\s*/y;
  let index = start[0].length;
  while (index < statement.length) {
    budget.take();
    header.lastIndex = index;
    const entry = header.exec(statement);
    if (!entry) break;
    const name = entry[1].toLowerCase();
    if (name === "quoted_value" || definitions.has(name)) known = false;
    index = header.lastIndex;
    definitions.set(name, { text: groups.get(offset + index - entry[2].length), order: index });
    separator.lastIndex = index;
    if (separator.exec(statement)) { index = separator.lastIndex; continue; }
    if (/^\s*(?:select|insert|replace|update|delete|merge|create)\b/i.test(statement.slice(index))) {
      return { main: index, definitions: known ? definitions : undefined };
    }
    break;
  }
  return undefined;
}

function boundedCte(name: string, definitions: Map<string, CteBody>,
  analyzeBody: (text: string) => boolean, budget: AnalysisBudget): boolean {
  const path: CteBody[] = [];
  let current = definitions.get(name);
  let bounded = false;
  while (current?.text) {
    budget.take();
    if (current.bounded !== undefined) { bounded = current.bounded; break; }
    path.push(current);
    const parent = directCteSource(current.text, budget);
    const earlier = parent && definitions.get(parent);
    if (earlier && earlier.order < current.order) { current = earlier; continue; }
    const uncapped = current.text.replace(concreteLimit, "");
    const relation = uncapped !== current.text && directCteSource(uncapped, budget);
    if (relation && !definitions.has(relation)) { bounded = true; break; }
    // SQL dialects can omit RECURSIVE. A branch-local limit does not bound
    // the number of recursive invocations. Accept an independent base SELECT.
    const tokens = new RegExp(sqlName, "gi");
    budget.take(current.text.length);
    let token: RegExpExecArray | null;
    while ((token = tokens.exec(current.text)) && !definitions.has(token[0].toLowerCase())) { budget.take(); }
    bounded = !token && /^\s*select\b/i.test(current.text) && analyzeBody(current.text);
    break;
  }
  for (const body of path) { budget.take(); body.bounded = bounded; }
  return bounded;
}

function startsSetOperand(prefix: string, budget: AnalysisBudget): boolean {
  let index = prefix.length;
  const word = (): string => {
    while (index && /\s/.test(prefix[index - 1])) { budget.take(); index--; }
    const end = index;
    while (index && /\w/.test(prefix[index - 1])) { budget.take(); index--; }
    return prefix.slice(index, end).toLowerCase();
  };
  let last = word();
  if (!last) return index === 0 || prefix[index - 1] === ";";
  if (last === "all" || last === "distinct") last = word();
  return last === "union" || last === "intersect" || last === "except";
}

/** Ignore SQL comments, quoted literals and nested subquery limits. */
function hasSqlLimit(sql: string): boolean {
  const budget = new AnalysisBudget("SQL bounds", Math.min(10_000_000, Math.max(50_000, sql.length * 10)));
  budget.take(sql.length);
  let hasCtes = /\bwith\b/i.test(sql) && !sql.includes("\0");
  const quotedNames = new Map<string, number>();
  let clean = "";
  for (let i = 0; i < sql.length;) {
    if (sql.startsWith("--", i)) { const end = sql.indexOf("\n", i); i = end < 0 ? sql.length : end; clean += " "; continue; }
    if (sql.startsWith("/*", i)) {
      if (sql.startsWith("/*!", i) || sql.startsWith("/*M!", i)) hasCtes = false;
      let nested = 1; i += 2;
      while (i < sql.length && nested) {
        if (sql.startsWith("/*", i)) { nested++; i += 2; }
        else if (sql.startsWith("*/", i)) { nested--; i += 2; }
        else i++;
      }
      if (nested) return false;
      clean += " "; continue;
    }
    const quote = sql[i];
    if (quote === "'" || quote === '"' || quote === "`") {
      const start = i;
      let closed = false;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) { i++; if (sql[i] === quote) { i++; continue; } closed = true; break; }
        if (sql[i] === "\\") { hasCtes = false; i++; }
        i++;
      }
      if (!closed) return false;
      if (hasCtes && quote !== "'") {
        const spelling = sql.slice(start, i);
        let id = quotedNames.get(spelling);
        if (id === undefined) { id = quotedNames.size; quotedNames.set(spelling, id); }
        clean += " \0q" + id + "\0 ";
      } else clean += " quoted_value ";
      continue;
    }
    if (sql[i] === "[" || sql[i] === "#") hasCtes = false;
    const dollar = sql[i] === "$" && (i === 0 || !/[\w$\u0080-\uffff]/.test(sql[i - 1]))
      && /^\$(?:[a-zA-Z_]\w*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      if (end < 0) return false;
      i = end + dollar[0].length; clean += " quoted_value "; continue;
    }
    clean += sql[i++];
  }
  // TOP (10) is a row cap, not a nested SELECT. Preserve its numeric value.
  clean = clean.replace(/\btop\s*\(\s*(\d+)\s*\)/gi, "TOP $1");
  const analyze = (text: string, level = 0, concrete = false): boolean => {
    if (level > 64) throw new AnalysisLimitError("SQL bounds recursion limit exceeded");
    let top = "";
    const groups = new Map<number, string>();
    for (let i = 0; i < text.length; i++) {
      budget.take();
      if (text[i] !== "(") { top += text[i]; continue; }
      let end = i + 1, nesting = 1, multipleArguments = false;
      for (; end < text.length && nesting; end++) {
        budget.take();
        if (text[end] === "(") nesting++;
        else if (text[end] === ")") nesting--;
        else if (nesting === 1 && text[end] === ",") multipleArguments = true;
      }
      if (nesting) return false;
      const body = text.slice(i + 1, end - 1);
      const queryOperand = /^\s*(?:select\b|with\b|\()/i.test(body) && startsSetOperand(top, budget);
      // Parenthesized set operands are queries; a FROM subquery's cap must
      // remain hidden from its outer SELECT.
      if (hasCtes && !concrete && !queryOperand && /^\s*select\b/i.test(body)) groups.set(top.length + 1, body);
      top += queryOperand
        ? analyze(body, level + 1, concrete) ? " SELECT TOP 1 branch " : " SELECT * branch "
        : multipleArguments ? " (args) " : " () ";
      i = end - 1;
    }
    let offset = 0;
    return top.split(";").every(statement => {
      const start = offset;
      offset += statement.length + 1;
      if (!statement.trim()) return true;
      // Names such as "merge" and "sales$update" inside WITH declarations
      // are not statement verbs. Determine the verb after the entire list.
      const withClause = /^\s*with\b/i.test(statement);
      const scope = withClause ? cteScope(statement, start, groups, budget) : undefined;
      if (withClause && !scope) return false;
      const main = scope ? statement.slice(scope.main) : statement;
      const command = /\b(select|insert|replace|update|delete|merge|create)\b/i.exec(main)?.[1].toLowerCase();
      const select = /\bselect\b/i.exec(main);
      let queryEnd: number | undefined;
      if (command === "create") return true;
      if (command !== "select") {
        const output = /\b(?:returning\b|output\s+(?:(?:inserted|deleted)\s*\.|\$action\b))/i.exec(main);
        if (!output) return true;
        // INSERT ... SELECT ... RETURNING cannot return more rows than its
        // source supplies. UPDATE/DELETE RETURNING have no such source bound.
        if (!select || command !== "insert" && command !== "replace") return false;
        if (output.index > select.index) queryEnd = output.index;
      }
      if (!select) return true;
      const query = main.slice(select.index, queryEnd);
      const definitions = hasCtes && !concrete && command === "select" ? scope?.definitions : undefined;
      const resultCap = (branch: string): boolean => concrete
        ? concreteLimit.test(branch)
        : /\blimit\s+(?:\d+|\$\d+|\?)/i.test(branch) || /\bfetch\s+(?:first|next)\s+\d+\s+rows?\s+only\b/i.test(branch);
      const bounded = (branch: string): boolean => {
        if (scalarProjection(branch) || resultCap(branch)
          || /^\s*select\s+(?:distinct\s+)?top\s+\d+\b(?!\s+(?:percent|with\s+ties)\b)/i.test(branch)) return true;
        if (!definitions) return false;
        const source = directCteSource(branch, budget);
        if (!source) return false;
        return boundedCte(source, definitions, body => analyze(body, level + 1, true), budget);
      };
      const operators = /\b(?:union|intersect|except)(?:\s+(?:all|distinct))?\b/i;
      const parts = query.split(operators);
      if (parts.length === 1) return bounded(query);
      // A final LIMIT/FETCH bounds the complete set expression. TOP is branch-local.
      const last = parts[parts.length - 1];
      if (resultCap(last)) return true;
      if (concrete) return parts.every(bounded);
      // UNION can add rows from every branch; INTERSECT cannot exceed either
      // operand and EXCEPT cannot exceed its left operand.
      return query.split(/\bunion(?:\s+(?:all|distinct))?\b/i).every(unionBranch => {
        const left = unionBranch.split(/\bexcept(?:\s+(?:all|distinct))?\b/i)[0];
        return left.split(/\bintersect(?:\s+(?:all|distinct))?\b/i).some(branch => bounded(branch));
      });
    });
  };
  return analyze(clean);
}

/** All outer projections must be scalar. Window functions and grouped
 * aggregates can yield one row per input or group. SQLite's multi-argument
 * min/max are ordinary scalar functions evaluated separately for each row. */
function scalarProjection(branch: string): boolean {
  if (/\bgroup\s+by\b/i.test(branch)) return false;
  const select = /^\s*select\s+(?:distinct\s+)?/i.exec(branch);
  if (!select) return false;
  const from = /\bfrom\b/i.exec(branch);
  const columns = branch.slice(select[0].length, from?.index).split(",");
  let aggregate = false;
  for (const column of columns) {
    const item = column.trim();
    if (/^(?:(?:min|max)\s*\(\)|(?:count|sum|avg)\s*\((?:args)?\))(?:\s+filter\s*\(\))?(?:\s+(?:as\s+)?(?:\w+|\x00q\d+\x00))?$/i.test(item)) {
      aggregate = true;
    } else if (!/^(?:[+-]?\d+(?:\.\d+)?|null|true|false)(?:\s+(?:as\s+)?(?:\w+|\x00q\d+\x00))?$/i.test(item)) {
      return false;
    }
  }
  return aggregate || !from;
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
  const options = asObjectLiteral(config);
  if (!options) return "unknown";
  const effective = new Map<string, ts.Expression | undefined>();
  let unknown = false;
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property) || (property.name && ts.isComputedPropertyName(property.name))) {
      effective.clear(); unknown = true; continue;
    }
    const name = property.name?.getText().replace(/['"]/g, "");
    if (name && PAGINATION_KEYS.has(name)) effective.set(name, ts.isPropertyAssignment(property) ? property.initializer
      : ts.isShorthandPropertyAssignment(property) ? property.name : undefined);
  }
  for (const value of effective.values()) {
    if (!value) unknown = true; // An accessor/method replaced an earlier cap.
    else if (ts.isNumericLiteral(value)) { if (Number(value.text) > 0) return "bounded"; }
    else if (value.kind !== ts.SyntaxKind.NullKeyword && !(ts.isIdentifier(value) && value.text === "undefined")) unknown = true;
  }
  return unknown ? "unknown" : "unbounded";
}
