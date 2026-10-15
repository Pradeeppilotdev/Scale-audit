import { readFile } from "node:fs/promises";
import path from "node:path";
import { glob } from "glob";
import ts from "typescript";
import { listSourceFiles, readFileSafe, parseSource, lineOf, snippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";

interface PrismaModel {
  name: string;
  indexed: Set<string>;
}

export async function detectMissingIndexes(root: string): Promise<Finding[]> {
  const models = await loadModels(root);
  if (models.size === 0) return []; // no schema -> no reliable signal
  const out: Finding[] = [];
  const files = await listSourceFiles(root);
  for (const rel of files) {
    const content = await readFileSafe(root, rel);
    if (!content) continue;
    const sf = parseSource(rel, content);
    if (!sf) continue;
    visit(sf, sf, content, rel, models, out);
  }
  return out;
}

async function loadModels(root: string): Promise<Map<string, PrismaModel>> {
  const files = await glob("**/*.prisma", { cwd: root, ignore: ["**/node_modules/**"], nodir: true });
  const models = new Map<string, PrismaModel>();
  for (const f of files) {
    const content = await readFile(path.join(root, f), "utf8").catch(() => "");
    const blocks = [...content.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)];
    for (const [, name, body] of blocks) {
      const indexed = new Set<string>();
      // field-level and block-level indexes only apply to this model
      for (const line of body.split("\n")) {
        const trimmed = line.trim();
        const idm = trimmed.match(/^(\w+)\s+\w+.*@id\b/);
        if (idm) indexed.add(idm[1]);
        const unm = trimmed.match(/^(\w+)\s+\w+.*@unique\b/);
        if (unm) indexed.add(unm[1]);
        const blockIdx = trimmed.match(/@@(?:index|unique)\(\s*\[([^\]]+)\]/);
        if (blockIdx) {
          for (const field of blockIdx[1].split(",")) {
            const fieldName = field.trim().split(/\s/)[0];
            if (fieldName) indexed.add(fieldName);
          }
        }
      }
      models.set(name.toLowerCase(), { name, indexed });
    }
  }
  return models;
}

function visit(
  node: ts.Node,
  sf: ts.SourceFile,
  content: string,
  rel: string,
  models: Map<string, PrismaModel>,
  out: Finding[],
) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.getText();
    if (isPrismaRead(method)) {
      const modelName = modelNameOf(node.expression.expression);
      const model = modelName ? models.get(modelName.toLowerCase()) : undefined;
      if (model) {
        const where = findWhereObject(node);
        if (where) {
          for (const p of where.properties) {
            if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue;
            const field = p.name.getText().replace(/['"]/g, "");
            if (!field) continue;
            // Logical operators and nested relation filters are not columns.
            if (field === "OR" || field === "AND" || field === "NOT") continue;
            if (ts.isPropertyAssignment(p)) {
              const val = unwrap(p.initializer);
              if (ts.isObjectLiteralExpression(val) || ts.isArrayLiteralExpression(val)) continue;
              // `field: null` / `field: undefined` style negation is rarely scale-relevant.
              if (val.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(val) && val.text === "undefined")) continue;
            }
            if (!model.indexed.has(field)) {
              const ln = lineOf(sf, node);
              out.push(
                makeFinding({
                  id: "missing-index",
                  category: "DB",
                  severity: "medium",
                  confidence: "medium",
                  file: rel,
                  line: ln,
                  message: `Query on model "${model.name}" filters on "${field}", which is not declared as @id/@unique/@@index.`,
                  scaleTrigger: "Unindexed filter becomes a full table scan as rows grow.",
                  suggestedFix: `Add an index for the filter column (\`@@index([${field}])\` or \`@unique\`) if this query runs frequently, or constrain the filter.`,
                  snippet: snippetAt(content, ln),
                }),
              );
            }
          }
        }
      }
    }
  }
  ts.forEachChild(node, (c) => visit(c, sf, content, rel, models, out));
}

function isPrismaRead(method: string): boolean {
  return ["findMany", "findFirst", "findUnique", "findUniqueOrThrow", "findFirstOrThrow", "count", "aggregate", "groupBy"].includes(method);
}

/** Extract the model token from `prisma.user` / `tx.user` / `this.prisma.user`. */
function modelNameOf(expr: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(expr)) return expr.name.getText();
  return null;
}

function unwrap(expr: ts.Expression): ts.Expression {
  let val = expr;
  while (ts.isAsExpression(val) || ts.isParenthesizedExpression(val) || ts.isTypeAssertionExpression(val) || ts.isNonNullExpression(val)) {
    val = (val as any).expression;
  }
  return val;
}

function findWhereObject(node: ts.CallExpression): ts.ObjectLiteralExpression | null {
  const arg = node.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
  for (const p of arg.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText().replace(/['"]/g, "") === "where") {
      const val = unwrap(p.initializer);
      if (ts.isObjectLiteralExpression(val)) return val;
    }
  }
  return null;
}
