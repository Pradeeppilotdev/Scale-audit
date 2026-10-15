import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { glob } from "glob";
import ts from "typescript";
import type { Finding } from "../types.js";

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
    const kind = rel.endsWith(".tsx") || rel.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    return ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, true, kind);
  } catch {
    return null;
  }
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
]);

const AMBIGUOUS_ORM_METHODS = new Set(["find", "findOne", "findFirst", "query", "execute", "select"]);

const DB_RECEIVER = /(^|\.)(prisma|db|database|client|repository|repo|manager|connection|knex|mongoose|sequelize|orm)(\.|$)/i;

export function isOrmCall(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const methodName = node.expression.name.getText();
  if (STRONG_ORM_METHODS.has(methodName)) return true;
  if (!AMBIGUOUS_ORM_METHODS.has(methodName)) return false;

  // Array helpers take a callback as first argument; ORM reads never do.
  const first = node.arguments[0];
  if (first && (ts.isArrowFunction(first) || ts.isFunctionExpression(first))) return false;

  const receiver = node.expression.expression.getText();
  if (DB_RECEIVER.test(receiver)) return true;

  // Mongoose/TypeORM style static model calls (User.find, User.findOne).
  // Excluded for array helpers by the callback check above.
  if (/^[A-Z][A-Za-z0-9_]*$/.test(receiver)) return true;

  return false;
}
