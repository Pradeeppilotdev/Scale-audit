import { readFile } from "node:fs/promises";
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
      "**/*.d.ts",
      "**/test/**",
      "**/tests/**",
      "**/__tests__/**",
      "**/*.test.*",
      "**/*.spec.*",
    ],
    nodir: true,
    absolute: false,
  });
  return files.sort();
}

export async function readFileSafe(root: string, rel: string): Promise<string | null> {
  try {
    return await readFile(path.join(root, rel), "utf8");
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

export const ORM_CALL_NAMES = new Set([
  "find",
  "findOne",
  "findMany",
  "findAll",
  "findUnique",
  "findFirst",
  "findByPk",
  "query",
  "execute",
  "select",
  "aggregate",
]);

export function isOrmCall(node: ts.CallExpression): boolean {
  if (ts.isPropertyAccessExpression(node.expression)) {
    const methodName = node.expression.name.getText();
    if (!ORM_CALL_NAMES.has(methodName)) return false;
    // Strong ORM-only method names that are rarely array helpers.
    if (["findMany", "findAll", "findUnique", "findUniqueOrThrow", "findFirst", "findByPk", "aggregate", "query", "execute", "select"].includes(methodName)) {
      return true;
    }
    // Ambiguous names (find, findOne): require a DB-ish receiver.
    const receiver = node.expression.expression.getText();
    const lower = receiver.toLowerCase();
    if (/(prisma|db|repository|repo|manager|connection|collection|store|knex|mongoose|sequelize|em|orm|client)/.test(lower)) return true;
    if (/^[A-Z]/.test(receiver)) return true; // Model.find (Mongoose/TypeORM static)
    return false;
  }
  if (ts.isIdentifier(node.expression)) {
    // standalone query helpers are only considered if name is clearly a query function
    return /^(query|execute|select)$/i.test(node.expression.text);
  }
  return false;
}
