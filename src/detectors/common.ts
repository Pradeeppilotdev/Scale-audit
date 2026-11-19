import { readRepoFile, walkRepo } from "../repoFiles.js";
import ts from "typescript";
import type { Finding } from "../types.js";
import type { FileContext } from "../context.js";
import { lastSegment } from "../context.js";
import { bindingWriteIndex, currentImportedBinding, currentInitializer, projectFor, symbolOf } from "../bindings.js";
import { staticExpression, staticProperties } from "../staticValues.js";
import type { AnalysisBudget } from "../analysisBudget.js";

export async function listSourceFiles(root: string): Promise<string[]> {
  const ignoredDirs = new Set([
    "node_modules", "dist", "build", "coverage", "venv", "test", "tests", "__tests__",
    "examples", "example", "docs", "benchmarks", "sandbox",
  ]);
  const files: string[] = [];
  for await (const { rel, directory } of walkRepo(root, {
    ignore: (rel, directory) => (directory && ignoredDirs.has(rel.split("/").at(-1)!)) || /\.(test|spec)\./.test(rel),
  })) {
    if (directory || !/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(rel) || /\.d\.(?:ts|mts|cts)$/.test(rel)) continue;
    files.push(rel);
    if (files.length > 20_000) throw new Error("Repository source file count exceeds limit of 20000");
  }
  return files.sort();
}

export async function readFileSafe(root: string, rel: string): Promise<string | null> {
  return readRepoFile(root, rel);
}

export function parseSource(rel: string, content: string, module = /\.(mts|mjs)$/.test(rel)): ts.SourceFile | null {
  try {
    // Module context must be present during parsing: otherwise `await (x)` in
    // an import-free ESM file is parsed as a call to an identifier named await.
    const options: ts.CreateSourceFileOptions = { languageVersion: ts.ScriptTarget.Latest };
    if (module) {
      options.impliedNodeFormat = ts.ModuleKind.ESNext;
      options.setExternalModuleIndicator = file => { Object.assign(file, { externalModuleIndicator: true }); };
    }
    return ts.createSourceFile(rel, content, options, true, scriptKindOf(rel));
  } catch {
    return null;
  }
}

/**
 * Pick the right ScriptKind per extension.
 *
 * `.js` must be parsed as JS (not TS): the TypeScript parser enables JSX for
 * ScriptKind.JS, so JSX in a Next.js `pages/` file parses instead of silently
 * degrading into error nodes.
 */
export function scriptKindOf(rel: string): ts.ScriptKind {
  if (rel.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (rel.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (rel.endsWith(".js") || rel.endsWith(".mjs") || rel.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

export function locationOf(sf: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { line: line + 1, column: character + 1 };
}

/** Reuse the parser's line offsets when extracting many findings from one file. */
export function sourceSnippetAt(source: ts.SourceFile, line: number): string {
  const starts = source.getLineStarts();
  const start = starts[Math.max(0, line - 2)];
  const next = starts[line + 1];
  const end = next === undefined ? source.text.length : next - 1;
  return source.text.slice(start, Math.min(end, start + 500));
}

export function makeFinding(partial: Omit<Finding, "snippet"> & { snippet?: string }): Finding {
  return { snippet: "", ...partial };
}

const PAGINATION_CHAIN = new Set(["limit", "take", "first", "top", "last", "perPage"]);

/** Inspect the outermost cap first so later chained overrides win. */
export function chainedPagination(node: ts.CallExpression): "bounded" | "unbounded" | "unknown" | undefined {
  let outer: ts.Node = node;
  while (outer.parent && ((ts.isPropertyAccessExpression(outer.parent) && outer.parent.expression === outer)
    || (ts.isCallExpression(outer.parent) && outer.parent.expression === outer))) outer = outer.parent;
  let current: ts.Node = outer;
  while (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) {
    if (ts.isCallExpression(current)) {
      const expression = current.expression;
      if (ts.isPropertyAccessExpression(expression) && PAGINATION_CHAIN.has(expression.name.text)) {
        const value = current.arguments[0];
        if (!value || value.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(value) && value.text === "undefined")) return "unbounded";
        return ts.isNumericLiteral(value) ? Number(value.text) > 0 ? "bounded" : "unbounded" : "unknown";
      }
      current = expression;
    } else current = current.expression;
  }
  return undefined;
}

export function hasChainedPagination(node: ts.CallExpression): boolean {
  return chainedPagination(node) === "bounded";
}

const STRONG_ORM_METHODS = new Set([
  "select",
  "all",
  "findMany",
  "findAll",
  "findUnique",
  "findUniqueOrThrow",
  "findFirstOrThrow",
  "findByPk",
  "aggregate",
  "count",
  "groupBy",
]);

const AMBIGUOUS_ORM_METHODS = new Set(["find", "findOne", "findFirst", "query"]);

export const DB_RECEIVER = /(^|\.)(prisma|db|database|knex|mongoose|sequelize|orm|connection|manager|(\w+)?repo(sitory)?)(\.|$)/i;

/**
 * Receivers that imply a database/queue client for write calls.
 *
 * Deliberately narrow: "pool" and "client" are excluded because plenty of
 * libraries have their own `pool`/`client` objects that are not databases.
 */
export const DB_WRITE_RECEIVER = /(^|\.)(prisma|db|database|redis|redisClient|knex|sequelize|mongoose|orm|conn|connection|sql)(\.|$)/i;

/**
 * Receiver names that are clearly business logic rather than data access.
 * `UserService.find()` is a very common false positive; `UserRepository.findMany()`
 * is a genuine database read, so "repository" is deliberately absent from this list.
 */
const NON_DATA_RECEIVER = /(Service|Controller|Resolver|Helper|Helpers|Util|Utils|Factory|Builder|Validator|Mapper|Serializer|Presenter|Formatter|Provider|Handler|Middleware|Guard|Strategy|Pipeline)$/;

const sqlAllocations = new WeakMap<ts.Node, ts.Node | null>();

function sqlAllocation(receiver: ts.Expression): ts.Node | undefined {
  const declaration = ts.isIdentifier(receiver) ? symbolOf(receiver)?.valueDeclaration : undefined;
  const captured = declaration && ts.isVariableDeclaration(declaration) ? currentInitializer(declaration, receiver) : receiver;
  if (!captured) return undefined;
  const known = sqlAllocations.get(captured);
  if (known !== undefined) return known ?? undefined;
  const value = staticExpression(captured, new Set(), bindingWriteIndex(captured.getSourceFile()).budget);
  sqlAllocations.set(captured, value ?? null);
  return value;
}

type SqlIdentifierDialect = "postgres" | "sqlite";
type SqlFactory = "Pool" | "Client" | "libsql" | "knex";
const knexDialects = new WeakMap<ts.CallExpression, SqlIdentifierDialect | null>();

function pgConstructor(expression: ts.Expression): "Pool" | "Client" | undefined {
  const imported = currentImportedBinding(expression);
  return imported?.module === "pg" && (imported.name === "Pool" || imported.name === "Client") ? imported.name : undefined;
}

function sqlFactory(value: ts.Node | undefined): SqlFactory | undefined {
  if (!value) return;
  if (ts.isNewExpression(value)) return pgConstructor(value.expression);
  if (!ts.isCallExpression(value)) return;
  const factory = currentImportedBinding(value.expression);
  if (factory?.module === "@libsql/client" && factory.name === "createClient") return "libsql";
  if (factory?.module === "knex" && ["default", "knex", "*"].includes(factory.name)) return "knex";
}

/** A Pool or Client remains a database receiver under application-specific names. */
export function isPostgresClient(receiver: ts.Expression): boolean {
  const value = sqlAllocation(receiver);
  return !!value && ts.isNewExpression(value) && !!pgConstructor(value.expression);
}

export function isLibsqlClient(receiver: ts.Expression): boolean {
  return sqlFactory(sqlAllocation(receiver)) === "libsql";
}

// A per-project index keeps a method patched through one alias from acquiring
// driver evidence through another. A direct top-level write only affects later
// top-level calls; functions can be invoked after the patch.
type SqlWrites = Map<ts.Node | SqlFactory, Map<string, ts.Statement | null>>;
const sqlMethodWrites = new WeakMap<object, SqlWrites>();
const writeReceivers = new WeakMap<ts.Node, ts.Node | null>();
const writeReceiverFields = new WeakMap<ts.ObjectLiteralExpression | ts.ArrayLiteralExpression, Map<string, ts.Node>>();

function sqlMember(value: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(value)) return value.name.text;
  return ts.isStringLiteralLike(value.argumentExpression) || ts.isNumericLiteral(value.argumentExpression) ? value.argumentExpression.text : undefined;
}

// Follow stored clients for invalidation only. The write index records later
// values assigned into properties as escapes as well. A container cannot
// supply positive evidence about which driver executes a query.
function writeReceiver(target: ts.Expression, budget: AnalysisBudget): ts.Node | undefined {
  let value = sqlAllocation(target);
  const seen = new Set<ts.Node>();
  while (value && (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value))) {
    budget.take();
    if (writeReceivers.has(value)) { value = writeReceivers.get(value) ?? undefined; break; }
    if (seen.has(value)) { value = undefined; break; }
    seen.add(value);
    const decl = symbolOf(ts.isPropertyAccessExpression(value) ? value : value.argumentExpression)?.valueDeclaration;
    let field = decl && (ts.isPropertyAssignment(decl) ? decl.initializer : ts.isShorthandPropertyAssignment(decl) ? decl.name : undefined);
    if (!field) {
      const member = sqlMember(value), object = sqlAllocation(value.expression);
      if (member === undefined || !object || !(ts.isObjectLiteralExpression(object) || ts.isArrayLiteralExpression(object))) break;
      let fields = writeReceiverFields.get(object);
      if (!fields) {
        fields = ts.isObjectLiteralExpression(object) ? staticProperties(object, budget) : new Map<string, ts.Node>();
        if (ts.isArrayLiteralExpression(object)) for (const [i, entry] of object.elements.entries()) {
          budget.take();
          if (ts.isSpreadElement(entry)) break;
          fields.set(String(i), entry);
        }
        writeReceiverFields.set(object, fields);
      }
      const stored = fields.get(member);
      if (stored && ts.isExpression(stored) && stored.pos >= 0) field = stored;
    }
    if (!field) break;
    value = sqlAllocation(field);
  }
  for (const visited of seen) { budget.take(); writeReceivers.set(visited, value ?? null); }
  return value;
}

function sqlWriteTarget(target: ts.Expression, budget: AnalysisBudget): ts.Node | SqlFactory | undefined {
  const value = writeReceiver(target, budget);
  if (!value) return;
  if (ts.isCallExpression(value) && value.arguments[0]) {
    const callee = sqlAllocation(value.expression);
    if (callee && (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
      && sqlMember(callee) === "getPrototypeOf" && ts.isIdentifier(callee.expression)
      && (callee.expression.text === "Object" || callee.expression.text === "Reflect") && !symbolOf(callee.expression)) {
      return sqlFactory(writeReceiver(value.arguments[0], budget));
    }
  }
  if (ts.isNewExpression(value) || ts.isCallExpression(value)) return value;
  if (!(ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value))) return;
  const name = sqlMember(value);
  if (name === "__proto__") return sqlFactory(writeReceiver(value.expression, budget));
  if (name !== "prototype") return;
  const imported = pgConstructor(value.expression);
  if (imported) return imported;
  const ctor = writeReceiver(value.expression, budget);
  if (ctor && (ts.isPropertyAccessExpression(ctor) || ts.isElementAccessExpression(ctor)) && sqlMember(ctor) === "constructor") {
    return sqlFactory(writeReceiver(ctor.expression, budget));
  }
}

function writesForSqlClients(sf: ts.SourceFile): SqlWrites {
  const project = projectFor(sf), scope = project ?? sf, cached = sqlMethodWrites.get(scope);
  if (cached) return cached;
  const writes: SqlWrites = new Map();
  for (const file of project?.sources.values() ?? [sf]) {
    const index = bindingWriteIndex(file);
    for (const { node, receiver: target, name } of index.nativeWrites) {
      index.budget.take();
      if (!target || (name !== undefined && name !== "query" && name !== "execute" && name !== "raw")) continue;
      // These capture a value. The write to the stored member is indexed at its own site.
      if (ts.isReturnStatement(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)
        || ts.isShorthandPropertyAssignment(node) || ts.isArrayLiteralExpression(node)) continue;
      if (ts.isLiteralExpression(target) || ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target)) continue;
      const value = sqlWriteTarget(target, index.budget);
      if (!value) continue;
      const methods = writes.get(value) ?? new Map<string, ts.Statement | null>();
      const member = name ?? "*";
      const statement = ts.isExpressionStatement(node.parent) && node.parent.parent === file ? node.parent : null;
      const first = methods.get(member);
      if (first === undefined) methods.set(member, statement);
      else if (first && (!statement || first.getSourceFile() !== file || statement.pos < first.pos)) {
        methods.set(member, statement && first.getSourceFile() === file ? statement : null);
      }
      writes.set(value, methods);
    }
  }
  sqlMethodWrites.set(scope, writes);
  return writes;
}

function hasSqlMethodWrite(receiver: ts.Expression, method: string, allocation: ts.Node, factory: SqlFactory): boolean {
  const sf = receiver.getSourceFile(), writes = writesForSqlClients(sf);
  for (const key of [allocation, factory]) for (const member of [method, "*"]) {
    const write = writes.get(key)?.get(member);
    if (write === undefined) continue;
    if (!write || write.getSourceFile() !== sf || write.pos <= receiver.pos ||
        ts.findAncestor(receiver, node => ts.isFunctionLike(node) || ts.isClassLike(node))) return true;
  }
  return false;
}

function knexIdentifierDialect(factory: ts.CallExpression): SqlIdentifierDialect | undefined {
  const cached = knexDialects.get(factory);
  if (cached !== undefined) return cached ?? undefined;
  const options = factory.arguments[0] && asObjectLiteral(factory.arguments[0]);
  let dialect: SqlIdentifierDialect | undefined;
  if (options) {
    const budget = bindingWriteIndex(factory.getSourceFile()).budget;
    // Knex reads the final client option. A later spread or computed key may replace it.
    for (let i = options.properties.length - 1; i >= 0; i--) {
      budget.take();
      const prop = options.properties[i];
      if (ts.isSpreadAssignment(prop) || ts.isComputedPropertyName(prop.name)) break;
      if (!(ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) || prop.name.text !== "client") continue;
      if (ts.isPropertyAssignment(prop) && ts.isStringLiteralLike(prop.initializer)) {
        switch (prop.initializer.text) {
          case "pg": case "postgres": case "postgresql": dialect = "postgres"; break;
          case "sqlite3": case "better-sqlite3": dialect = "sqlite"; break;
        }
      }
      break;
    }
  }
  knexDialects.set(factory, dialect ?? null);
  return dialect;
}

/** Attribute identifier folding to the client that receives this particular query. */
export function sqlIdentifierDialect(receiver: ts.Expression, method: string): SqlIdentifierDialect | undefined {
  const value = sqlAllocation(receiver), factory = sqlFactory(value);
  if (!value || !factory) return;
  let dialect: SqlIdentifierDialect | undefined;
  if (method === "query" && (factory === "Pool" || factory === "Client")) dialect = "postgres";
  else if (method === "execute" && factory === "libsql") dialect = "sqlite";
  else if (method === "raw" && factory === "knex" && ts.isCallExpression(value)) dialect = knexIdentifierDialect(value);
  return dialect && !hasSqlMethodWrite(receiver, method, value, factory) ? dialect : undefined;
}

/**
 * True when the call is a database read.
 *
 * Capitalised receivers used to be assumed to be models, which flagged every
 * `UserService.find()` in the world. A capitalised receiver now needs evidence:
 * it is a known model (bound to a model factory, imported from an entity/model
 * path, or present in a Prisma schema) or the file imports an ORM.
 */
export function isOrmCall(node: ts.CallExpression, ctx?: FileContext): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const methodName = node.expression.name.getText();
  const receiver = node.expression.expression.getText();
  if (methodName === "select" || methodName === "all") {
    const root = /^[A-Za-z_$][\w$]*/.exec(receiver)?.[0];
    const importedDb = root && ctx && [...ctx.imports].some(([module, bindings]) =>
      /^(?:knex|drizzle-orm(?:\/.*)?|kysely|@prisma\/client)$/.test(module) && bindings.has(root));
    if (!DB_RECEIVER.test(receiver) && !importedDb) return false;
  }


  const strong = STRONG_ORM_METHODS.has(methodName);
  const ambiguous = AMBIGUOUS_ORM_METHODS.has(methodName);
  if (!strong && !ambiguous) return false;

  // Array helpers take a callback as first argument; ORM reads never do.
  const first = node.arguments[0];
  if (first && (ts.isArrowFunction(first) || ts.isFunctionExpression(first))) return false;

  if (methodName === "query" && isPostgresClient(node.expression.expression)) return true;

  // `UserService.find()` and friends are not database reads.
  if (NON_DATA_RECEIVER.test(receiver)) return false;

  if (strong) {
    if (DB_RECEIVER.test(receiver)) return true;
    if (!ctx) return true;
    // Strong method names are distinctive, but still need some signal that this
    // file talks to a database.
    return ctx.hasOrmImport || isKnownModel(receiver, ctx);
  }

  // Bare `client` is ambiguous (Apollo/SDK clients vs node-postgres).
  // Only treat as a DB call when it looks like raw SQL: client.query("...") or
  // client.query({ text: "..." }) — not client.query({ query: gql`...` }).
  if (/(^|\.)client$/.test(receiver)) {
    if (!first) return false;
    if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first) || ts.isTemplateExpression(first)) return true;
    const obj = asObjectLiteral(first);
    return Boolean(
      obj &&
        obj.properties.some(
          (p) =>
            (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText().replace(/['"]/g, "") === "text",
        ),
    );
  }

  if (DB_RECEIVER.test(receiver)) return true;

  // A capitalised receiver is only a model when we can prove it.
  return ctx ? isKnownModel(receiver, ctx) : /^[A-Z][A-Za-z0-9_]*$/.test(receiver);
}

/** True when the receiver is a model we have evidence for. */
export function isKnownModel(receiver: string, ctx: FileContext): boolean {
  // `mongoose.models.User`, `mongoose.model("User")` accessed off the namespace.
  const viaModels = receiver.match(/(^|\.)models\.([A-Za-z_$][\w$]*)$/);
  if (viaModels) {
    if (ctx.knownModels.has(viaModels[2])) return true;
    if (ctx.schemaModels.has(viaModels[2].toLowerCase())) return true;
    if (ctx.hasOrmImport) return true;
  }

  const seg = lastSegment(receiver);
  if (!seg) return false;
  if (ctx.knownModels.has(seg)) return true;
  if (ctx.schemaModels.has(seg.toLowerCase())) return true;
  return false;
}

export function asObjectLiteral(expr: ts.Expression): ts.ObjectLiteralExpression | null {
  let val = expr;
  while (ts.isAsExpression(val) || ts.isParenthesizedExpression(val) || ts.isTypeAssertionExpression(val)
    || ts.isNonNullExpression(val) || ts.isSatisfiesExpression(val)) {
    val = val.expression;
  }
  return ts.isObjectLiteralExpression(val) ? val : null;
}
