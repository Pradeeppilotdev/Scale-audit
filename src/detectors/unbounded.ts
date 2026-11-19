import ts from "typescript";
import { AnalysisBudget, AnalysisLimitError } from "../analysisBudget.js";
import { locationOf, sourceSnippetAt, makeFinding, isOrmCall, chainedPagination, asObjectLiteral, DB_RECEIVER, isKnownModel, isPostgresClient, isLibsqlClient, sqlIdentifierDialect } from "./common.js";
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
  const raw = rawQueryInfo(node) ?? (ts.isCallExpression(node) ? rawClientQuery(node) : null);
  if (raw) {
    const bound = raw.sql === null ? "runtime" : sqlRowBound(raw.sql, () => {
      const member = ts.isCallExpression(node) ? node.expression : ts.isTaggedTemplateExpression(node) ? node.tag : undefined;
      if (member && (ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member))) {
        const method = ts.isPropertyAccessExpression(member) ? member.name.text
          : ts.isStringLiteralLike(member.argumentExpression) ? member.argumentExpression.text : "";
        return sqlIdentifierDialect(member.expression, method);
      }
    });
    if (bound !== "bounded") {
      const { line, column } = locationOf(sf, node);
      const high = bound === "unbounded";
      const message = bound === "runtime" ? "The SQL text is built at runtime, so its row limit could not be verified."
        : bound === "uncertain" ? "The database's identifier rules determine whether this query reads the capped CTE or a different table."
        : `The raw SQL query${raw.name ? ` via ${raw.name}` : ""} has no proven bound on the rows it returns.`;
      out.push(makeFinding({
        id: high ? "unbounded-raw-query" : "unbounded-read",
        category: "DB",
        severity: high ? "high" : "medium",
        confidence: high ? "high" : "low",
        file: rel, line, column, message,
        scaleTrigger: "As the underlying tables grow, an unbounded result can exhaust application memory.",
        suggestedFix: high ? "Add a LIMIT/ORDER BY + cursor window, and make sure the query is served by an index."
          : bound === "runtime" ? "Make sure the SQL always includes a LIMIT/parameterised page size."
          : "Use consistent CTE name quoting or add a limit to the outer SELECT.",
        snippet: sourceSnippetAt(sf, line),
      }));
    }
  } else if (ts.isCallExpression(node)) {
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
  ts.forEachChild(node, (c) => visitNode(c, sf, rel, ctx, out));
}

/**
 * Accept direct SQL or the driver's statement object. PostgreSQL reads
 * `text` and libSQL reads `sql`. A runtime value leaves pagination unknown.
 */
function rawClientQuery(node: ts.CallExpression): RawQuery | null {
  const member = node.expression;
  if (!ts.isPropertyAccessExpression(member) && !ts.isElementAccessExpression(member)) return null;
  const method = ts.isPropertyAccessExpression(member) ? member.name.text
    : ts.isStringLiteralLike(member.argumentExpression) ? member.argumentExpression.text : undefined;
  if (method !== "query" && method !== "execute") return null;
  const arg = node.arguments[0];
  const object = arg && asObjectLiteral(arg);
  const namedClient = /(^|\.)client$/.test(member.expression.getText());
  const libsql = method === "execute" && (!namedClient || !!object) && isLibsqlClient(member.expression);
  if (!namedClient && !libsql && !(method === "query" && isPostgresClient(member.expression))) return null;
  if (!arg) return { sql: null };
  if (!object) return { sql: sqlText(arg) };

  const field = libsql ? "sql" : "text";
  let hasField = false;
  let sql: string | null = null;
  for (const prop of object.properties) {
    if (ts.isSpreadAssignment(prop) || ts.isComputedPropertyName(prop.name)) {
      // An explicit later field can restore the statement text after an override.
      sql = null;
      if (libsql) hasField = true;
    } else if ((ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) && prop.name.text === field) {
      hasField = true;
      sql = ts.isPropertyAssignment(prop) ? sqlText(prop.initializer) : null;
    }
  }
  // An object containing only a GraphQL 'query' has no SQL statement field.
  return hasField ? { sql } : null;
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
  name?: string;
  sql: string | null;
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
const sqlName = "(?:[a-z_][a-z0-9_$]*|\\x00[qb]\\d+\\x00)";
// Literal values never participate in keyword matching. Only SQLite assigns
// an identity to a single-quoted token in a relation-name position.
const sqlString = "\\x00!\\d*\\x00";
const relationName = "(?:" + sqlName + "|" + sqlString + ")";
const columnName = sqlName + "(?:\\s*\\.\\s*" + sqlName + ")?";
const sqlAlias = "(?:\\s+(?:as\\s+)?" + relationName + ")?";
const cteColumn = new RegExp("^(?:\\*|" + sqlName + "\\s*\\.\\s*\\*|(?:" + columnName + "|" + sqlString + ")" + sqlAlias + ")$", "i");
const cteFrom = new RegExp("^(" + relationName + ")" + sqlAlias + "$", "i");
const operand = "(?:" + columnName + "|" + sqlString + "|[+-]?\\d+(?:\\.\\d+)?|\\?|\\$\\d+)";
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
  const source = cteFrom.exec(clauses[0].trim())?.[1];
  if (!source || source === "\0!\0") return undefined;
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

// A mask keeps one database's identifier rules consistent across all operands
// and statements. A cap is certain only when every applicable rule proves it.
enum Folding { Lower = 1, Upper = 2, Insensitive = 4, Exact = 8 }
type IdentifierKey = (token: string, folding: Folding) => string | undefined;
interface CteBody {
  text?: string;
  order: number;
  source?: string | null;
  cappedSource?: string | null;
  tokens?: string[];
  baseBound?: number;
  bracketed?: boolean;
  checked: number;
  bounded: number;
}
interface CteNames {
  folding: Folding;
  byName: Map<string, CteBody>;
}

/** The parentheses map identifies the actual body of each declaration in the
 * flattened statement. A same-named table in a different statement is unrelated. */
function cteScope(statement: string, offset: number, groups: ReadonlyMap<number, string>, modes: readonly Folding[],
  key: IdentifierKey, budget: AnalysisBudget): { main: number; definitions: CteNames[] } | undefined {
  const start = /^\s*with\s+(?:(recursive)\s+)?/i.exec(statement);
  if (!start) return undefined;
  const definitions = start[1] ? [] : modes.map(folding => ({ folding, byName: new Map<string, CteBody>() }));
  const header = new RegExp("(" + relationName + ")\\s*(?:\\((?:args)?\\)\\s*)?as\\s*(?:(?:not\\s+)?materialized\\s*)?(\\((?:args)?\\))", "iy");
  const separator = /\s*,\s*/y;
  let index = start[0].length;
  while (index < statement.length) {
    budget.take();
    header.lastIndex = index;
    const entry = header.exec(statement);
    if (!entry) break;
    index = header.lastIndex;
    const body: CteBody = { text: groups.get(offset + index - entry[2].length), order: index, checked: 0, bounded: 0 };
    for (let i = definitions.length - 1; i >= 0; i--) {
      budget.take();
      const { folding, byName } = definitions[i];
      const name = key(entry[1], folding);
      if (name === undefined || byName.has(name)) definitions.splice(i, 1);
      else byName.set(name, body);
    }
    separator.lastIndex = index;
    if (separator.exec(statement)) { index = separator.lastIndex; continue; }
    if (/^\s*(?:select|insert|replace|update|delete|merge|create)\b/i.test(statement.slice(index))) {
      return { main: index, definitions };
    }
    break;
  }
  return undefined;
}

/** SQLite accepts a single-quoted token as a table name after FROM, JOIN or
 * a table-list comma. A literal in a predicate or aggregate remains data. */
function possibleCteNames(text: string, budget: AnalysisBudget): string[] {
  if (!text.includes("\0!")) return text.match(new RegExp(sqlName, "gi")) ?? [];
  const names: string[] = [];
  const tableLists = [false];
  let source = false;
  for (const match of text.matchAll(new RegExp(sqlName + "|" + sqlString + "|[(),]", "gi"))) {
    budget.take();
    const token = match[0], depth = tableLists.length - 1;
    if (token === "(") { tableLists.push(source); continue; }
    if (token === ")") { if (depth) tableLists.pop(); source = false; continue; }
    if (token === ",") { source = tableLists[depth]; continue; }
    if (!token.startsWith("\0!") || source) names.push(token);
    source = /^(?:from|join)$/i.test(token);
    if (source) tableLists[depth] = true;
    else if (/^(?:select|where|group|having|order|limit|union|intersect|except|window|returning)$/i.test(token)) tableLists[depth] = false;
  }
  return names;
}

function boundedCte(name: string, { folding, byName }: CteNames, key: IdentifierKey,
  analyzeBody: (text: string) => number, budget: AnalysisBudget): boolean {
  const path: CteBody[] = [];
  const first = key(name, folding);
  let current = first === undefined ? undefined : byName.get(first);
  let bounded = false;
  while (current?.text) {
    budget.take();
    if (current.checked & folding) { bounded = !!(current.bounded & folding); break; }
    path.push(current);
    if (current.source === undefined) current.source = directCteSource(current.text, budget) ?? null;
    current.bracketed ??= current.text.includes("\0b");
    const source = current.source && (!current.bracketed || folding === Folding.Insensitive) ? key(current.source, folding) : undefined;
    const earlier = source === undefined ? undefined : byName.get(source);
    if (earlier && earlier.order < current.order) { current = earlier; continue; }
    if (current.cappedSource === undefined) {
      const uncapped = current.text.replace(concreteLimit, "");
      current.cappedSource = uncapped !== current.text ? directCteSource(uncapped, budget) ?? null : null;
    }
    const relation = current.cappedSource ? key(current.cappedSource, folding) : undefined;
    if (relation !== undefined && !byName.has(relation)) { bounded = true; break; }
    // SQL dialects can omit RECURSIVE. A branch-local limit cannot bound
    // recursive invocations. Only analyze an independent base SELECT.
    if (!current.tokens) {
      budget.take(current.text.length);
      current.tokens = possibleCteNames(current.text, budget);
    }
    const dependent = current.tokens.some(token => {
      budget.take();
      const identity = key(token, folding);
      return identity === undefined || byName.has(identity);
    });
    if (!dependent) {
      current.baseBound ??= /^\s*select\b/i.test(current.text) ? analyzeBody(current.text) : 0;
      bounded = !!(current.baseBound & folding);
    }
    break;
  }
  for (const body of path) {
    budget.take();
    body.checked |= folding;
    if (bounded) body.bounded |= folding;
  }
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
function sqlRowBound(sql: string, dialect: () => ReturnType<typeof sqlIdentifierDialect>): "bounded" | "unbounded" | "uncertain" {
  const budget = new AnalysisBudget("SQL bounds", Math.min(10_000_000, Math.max(50_000, sql.length * 10)));
  budget.take(sql.length);
  let hasCtes = /\bwith\b/i.test(sql) && !sql.includes("\0");
  const markers = new Map<string, string>();
  const spellings = new Map<string, { name: string; quoted: boolean }>();
  let doubleQuoted = false, backtickQuoted = false, sqliteQuoting = false;
  let driver: ReturnType<typeof sqlIdentifierDialect>, checkedDriver = false;
  const getDriver = () => {
    if (!checkedDriver) { driver = dialect(); checkedDriver = true; }
    return driver;
  };
  const marker = (spelling: string, quote = "") => {
    let token = markers.get(spelling);
    if (!token) {
      token = (quote === "'" ? "\0!" : quote === "[" ? "\0b" : "\0q") + markers.size + "\0";
      markers.set(spelling, token);
      let name = quote ? spelling.slice(1, -1) : spelling;
      if (quote && quote !== "[") name = name.replaceAll(quote + quote, quote);
      spellings.set(token, { name, quoted: !!quote });
    }
    return token;
  };
  const bareName = /[\p{L}_][\p{L}\p{M}\p{N}_$]*/uy;
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
      if (nested) return "unbounded";
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
      if (!closed) return "unbounded";
      if (hasCtes && (quote !== "'" || getDriver() !== "postgres")) {
        if (quote === '"') doubleQuoted = true;
        if (quote === "`") backtickQuoted = true;
        if (quote === "'") sqliteQuoting = true;
        clean += " " + marker(sql.slice(start, i), quote) + " ";
      } else clean += " \0!\0 ";
      continue;
    }
    if (sql[i] === "[" && hasCtes && getDriver() !== "postgres") {
      const end = sql.indexOf("]", i + 1);
      if (end < 0) return "unbounded";
      const contents = sql.slice(i + 1, end);
      // Array literals, comments and nested expressions can put a closing
      // bracket inside SQL data. Only simple names share an unambiguous end.
      if (driver === "sqlite" || /^[\p{L}\p{M}\p{N}_$. ]+$/u.test(contents) && !/\$(?:[a-z_]\w*)?\$/i.test(contents)) {
        sqliteQuoting = true;
        clean += " " + marker(sql.slice(i, end + 1), "[") + " ";
        i = end + 1;
        continue;
      }
    }
    if (hasCtes) {
      bareName.lastIndex = i;
      const name = bareName.exec(sql)?.[0];
      if (name) {
        // Keep the complete identifier. Its ASCII suffix cannot become a
        // set operator, LIMIT or the start of a dollar-quoted string.
        clean += /[^a-z0-9_]/i.test(name) ? marker(name) : name;
        i = bareName.lastIndex;
        continue;
      }
    }
    if (sql[i] === "[" || sql[i] === "#") hasCtes = false;
    const dollar = sql[i] === "$" && (i === 0 || !/[\w$\u0080-\uffff]/.test(sql[i - 1]))
      && /^\$(?:[a-zA-Z_]\w*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      if (end < 0) return "unbounded";
      i = end + dollar[0].length; clean += " \0!\0 "; continue;
    }
    clean += sql[i++];
  }
  // TOP (10) is a row cap, not a nested SELECT. Preserve its numeric value.
  clean = clean.replace(/\btop\s*\(\s*(\d+)\s*\)/gi, "TOP $1");
  if (hasCtes && (doubleQuoted || backtickQuoted)) getDriver();
  const modes = driver === "sqlite" ? [Folding.Insensitive] : driver === "postgres" || !hasCtes ? [Folding.Lower]
    : backtickQuoted ? [Folding.Exact, Folding.Insensitive] : doubleQuoted ? [Folding.Lower, Folding.Upper, Folding.Exact, Folding.Insensitive]
    : sqliteQuoting ? [Folding.Lower, Folding.Insensitive] : [Folding.Lower];
  const all = modes.reduce<number>((mask, mode) => mask | mode, 0);
  const keys = new Map<string, string[]>();
  const key: IdentifierKey = (token, folding) => {
    if (token === "\0!\0" || folding !== Folding.Insensitive && (token.startsWith("\0!") || token.startsWith("\0b"))) return undefined;
    let variants = keys.get(token);
    if (!variants) { variants = []; keys.set(token, variants); }
    if (variants[folding] !== undefined) return variants[folding];
    const spelling = spellings.get(token);
    const name = spelling?.name ?? token;
    budget.take(name.length);
    // SQLite folds ASCII letters only. Other dialects can preserve delimited
    // names and fold bare names up or down, or compare both case-sensitively.
    if (folding === Folding.Exact || spelling?.quoted && folding !== Folding.Insensitive) return variants[folding] = name;
    return variants[folding] = folding === Folding.Upper ? name.replace(/[a-z]/g, c => c.toUpperCase())
      : name.replace(/[A-Z]/g, c => c.toLowerCase());
  };
  const common = (parts: string[], check: (part: string) => number): number => {
    let mask = all;
    for (const part of parts) { mask &= check(part); if (!mask) break; }
    return mask;
  };
  const analyze = (text: string, level = 0, concrete = false): number => {
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
      if (nesting) return 0;
      const body = text.slice(i + 1, end - 1);
      const queryOperand = /^\s*(?:select\b|with\b|\()/i.test(body) && startsSetOperand(top, budget);
      // Parenthesized set operands are queries; a FROM subquery's cap must
      // remain hidden from its outer SELECT.
      if (hasCtes && !concrete && !queryOperand && /^\s*select\b/i.test(body)) groups.set(top.length + 1, body);
      if (queryOperand) {
        const mask = analyze(body, level + 1, concrete);
        top += mask === all ? " SELECT TOP 1 branch " : mask ? " SELECT * \0operand" + mask + "\0 " : " SELECT * branch ";
      } else top += multipleArguments ? " (args) " : " () ";
      i = end - 1;
    }
    let offset = 0;
    return common(top.split(";"), statement => {
      const start = offset;
      offset += statement.length + 1;
      if (!statement.trim()) return all;
      // Names such as "merge" and "sales$update" inside WITH declarations
      // are not statement verbs. Determine the verb after the entire list.
      const withClause = /^\s*with\b/i.test(statement);
      const scope = withClause ? cteScope(statement, start, groups, modes, key, budget) : undefined;
      if (withClause && !scope) return 0;
      const main = scope ? statement.slice(scope.main) : statement;
      const command = /\b(select|insert|replace|update|delete|merge|create)\b/i.exec(main)?.[1].toLowerCase();
      const select = /\bselect\b/i.exec(main);
      let queryEnd: number | undefined;
      if (command === "create") return all;
      if (command !== "select") {
        const output = /\b(?:returning\b|output\s+(?:(?:inserted|deleted)\s*\.|\$action\b))/i.exec(main);
        if (!output) return all;
        // INSERT ... SELECT ... RETURNING cannot return more rows than its
        // source supplies. UPDATE/DELETE RETURNING have no such source bound.
        if (!select || command !== "insert" && command !== "replace") return 0;
        if (output.index > select.index) queryEnd = output.index;
      }
      if (!select) return all;
      const query = main.slice(select.index, queryEnd);
      const definitions = hasCtes && !concrete && command === "select" ? scope?.definitions : undefined;
      const resultCap = (branch: string): boolean => concrete
        ? concreteLimit.test(branch)
        : /\blimit\s+(?:\d+|\$\d+|\?)/i.test(branch) || /\bfetch\s+(?:first|next)\s+\d+\s+rows?\s+only\b/i.test(branch);
      const bounded = (branch: string): number => {
        if (resultCap(branch)
          || /^\s*select\s+(?:distinct\s+)?top\s+\d+\b(?!\s+(?:percent|with\s+ties)\b)/i.test(branch)) return all;
        // Unknown brackets can denote an array expression in another dialect.
        // Only the SQLite interpretation may treat them as a column or alias.
        const projection = branch.includes("\0b") ? all & Folding.Insensitive : all;
        if (scalarProjection(branch)) return projection;
        // Parenthesized set operands keep their dialect-specific proof.
        const nested = hasCtes && /^\s*select \* \x00operand(\d+)\x00\s*(?:$|order\s+by\b)/i.exec(branch);
        if (nested) return Number(nested[1]);
        if (!definitions?.length) return 0;
        const source = directCteSource(branch, budget);
        if (!source) return 0;
        let mask = 0;
        for (const names of definitions) {
          budget.take();
          if (projection & names.folding && boundedCte(source, names, key, body => analyze(body, level + 1, true), budget)) mask |= names.folding;
        }
        return mask;
      };
      const operators = /\b(?:union|intersect|except)(?:\s+(?:all|distinct))?\b/i;
      const parts = query.split(operators);
      if (parts.length === 1) return bounded(query);
      // A final LIMIT/FETCH bounds the complete set expression. TOP is branch-local.
      const last = parts[parts.length - 1];
      if (resultCap(last)) return all;
      if (concrete) return common(parts, bounded);
      // UNION can add rows from every branch; INTERSECT cannot exceed either
      // operand and EXCEPT cannot exceed its left operand.
      return common(query.split(/\bunion(?:\s+(?:all|distinct))?\b/i), unionBranch => {
        const left = unionBranch.split(/\bexcept(?:\s+(?:all|distinct))?\b/i)[0];
        let mask = 0;
        for (const branch of left.split(/\bintersect(?:\s+(?:all|distinct))?\b/i)) {
          mask |= bounded(branch);
          if (mask === all) break;
        }
        return mask;
      });
    });
  };
  const bound = analyze(clean);
  return bound === all ? "bounded" : bound ? "uncertain" : "unbounded";
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
    if (/^(?:(?:min|max)\s*\(\)|(?:count|sum|avg)\s*\((?:args)?\))(?:\s+filter\s*\(\))?(?:\s+(?:as\s+)?(?:\w+|\x00[qb]\d+\x00))?$/i.test(item)) {
      aggregate = true;
    } else if (!/^(?:[+-]?\d+(?:\.\d+)?|null|true|false)(?:\s+(?:as\s+)?(?:\w+|\x00[qb]\d+\x00))?$/i.test(item)) {
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
