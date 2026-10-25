import path from "node:path";
import ts from "typescript";
import { lineOf, snippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";
import { findProjectDir, type PrismaModel } from "../prisma.js";
import { Workspace } from "../workspace.js";

export async function detectMissingIndexes(root: string, ws?: Workspace): Promise<Finding[]> {
  const workspace = ws ?? (await Workspace.load(root));
  const groups = workspace.schemaGroups;
  if (groups.global.size === 0) return []; // no schema -> no reliable signal

  const out: Finding[] = [];
  const dirCache = new Map<string, string | null>();

  for (const { rel, content, sf } of workspace.units) {
    // Use the schema of the file's own project so per-project indexes are accurate.
    const projectDir = await findProjectDir(root, path.posix.dirname(rel), dirCache);
    const models = (projectDir !== null ? groups.byProject.get(projectDir) : undefined) ?? groups.global;
    visit(sf, sf, content, rel, models, out);
  }
  return out;
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
          for (const field of filterFields(where, model)) {
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

/** Walk logical groups, but not relation subtrees or arbitrary JSON objects. */
function filterFields(where: ts.ObjectLiteralExpression, model: PrismaModel, depth = 0): Set<string> {
  const fields = new Set<string>();
  if (depth > 64) return fields;
  for (const property of where.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
    const field = property.name.getText().replace(/['"]/g, "");
    const value = ts.isPropertyAssignment(property) ? unwrap(property.initializer) : property.name;
    if (["AND", "OR", "NOT"].includes(field)) {
      for (const group of ts.isArrayLiteralExpression(value) ? value.elements : [value]) {
        if (ts.isObjectLiteralExpression(group)) for (const nested of filterFields(group, model, depth + 1)) fields.add(nested);
      }
      continue;
    }
    if (value.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(value) && value.text === "undefined")) continue;
    if (ts.isArrayLiteralExpression(value)) continue;
    if (ts.isObjectLiteralExpression(value)) {
      if (!model.scalarFields?.has(field)) continue;
      const keys = value.properties.map(p => p.name?.getText().replace(/['"]/g, ""));
      if (!keys.some(key => key && ["equals", "in", "notIn", "lt", "lte", "gt", "gte", "not", "startsWith", "endsWith", "contains"].includes(key))) continue;
    }
    fields.add(field);
  }
  return fields;
}
