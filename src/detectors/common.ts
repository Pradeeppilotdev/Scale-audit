import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { glob } from "glob";
import ts from "typescript";
import type { Finding } from "../types.js";
import type { FileContext } from "../context.js";
import { lastSegment } from "../context.js";

export async function listSourceFiles(root: string): Promise<string[]> {
  const files = await glob("**/*.{ts,tsx,js,jsx,mjs,cjs}", {
    cwd: root,
    ignore: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.git/**",
      "**/coverage/**",
      "**/.next/**",
      "**/.nuxt/**",
      "**/.svelte-kit/**",
      "**/.turbo/**",
      "**/.vercel/**",
      "**/.output/**",
      "**/.cache/**",
      "**/.venv/**",
      "**/venv/**",
      "**/*.d.ts",
      "**/test/**",
      "**/tests/**",
      "**/__tests__/**",
      "**/*.test.*",
      "**/*.spec.*",
      "**/examples/**",
      "**/example/**",
      "**/docs/**",
      "**/benchmarks/**",
      "**/sandbox/**",
    ],
    nodir: true,
    absolute: false,
    follow: false,
  });
  return files.sort().slice(0, 20_000);
}

export async function readFileSafe(root: string, rel: string): Promise<string | null> {
  try {
    const full = path.join(root, rel);
    const st = await lstat(full);
    if (st.isSymbolicLink() || st.size > 1_000_000) return null;
    return await readFile(full, "utf8");
  } catch {
    return null;
  }
}

export function parseSource(rel: string, content: string): ts.SourceFile | null {
  try {
    return ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, true, scriptKindOf(rel));
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

export function snippetAt(content: string, line: number, radius = 1): string {
  const lines = content.split("\n");
  const start = Math.max(0, line - 1 - radius);
  const end = Math.min(lines.length, line + radius);
  return lines.slice(start, end).join("\n").slice(0, 500);
}

export function makeFinding(partial: Omit<Finding, "snippet"> & { snippet?: string }): Finding {
  return { snippet: "", ...partial };
}

const PAGINATION_CHAIN = new Set(["limit", "take", "skip", "first", "top", "last", "offset", "page", "perPage"]);

/** True when a query call is chained with pagination helpers, e.g. Model.find().limit(10). */
export function hasChainedPagination(node: ts.CallExpression): boolean {
  let cur: ts.Node = node;
  while (cur.parent) {
    const p = cur.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === cur) {
      if (PAGINATION_CHAIN.has(p.name.getText())) return true;
      cur = p;
    } else if (ts.isCallExpression(p) && p.expression === cur) {
      cur = p;
    } else {
      break;
    }
  }
  return false;
}

const STRONG_ORM_METHODS = new Set([
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

  const strong = STRONG_ORM_METHODS.has(methodName);
  const ambiguous = AMBIGUOUS_ORM_METHODS.has(methodName);
  if (!strong && !ambiguous) return false;

  // Array helpers take a callback as first argument; ORM reads never do.
  const first = node.arguments[0];
  if (first && (ts.isArrowFunction(first) || ts.isFunctionExpression(first))) return false;

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
  while (ts.isAsExpression(val) || ts.isParenthesizedExpression(val) || ts.isTypeAssertionExpression(val) || ts.isNonNullExpression(val)) {
    val = (val as any).expression;
  }
  return ts.isObjectLiteralExpression(val) ? val : null;
}
