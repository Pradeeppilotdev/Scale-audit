import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { glob } from "glob";
import ts from "typescript";
import { listSourceFiles, readFileSafe, parseSource, lineOf, snippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";

interface PrismaModel {
  name: string;
  indexed: Set<string>;
}

interface SchemaGroups {
  /** Union of all schemas: fallback when a code file has no scoped schema. */
  global: Map<string, PrismaModel>;
  /** Keyed by project dir (nearest package.json above the schema); "" when none. */
  byProject: Map<string, Map<string, PrismaModel>>;
}

export async function detectMissingIndexes(root: string): Promise<Finding[]> {
  const groups = await loadSchemaGroups(root);
  if (groups.global.size === 0) return []; // no schema -> no reliable signal

  const out: Finding[] = [];
  const files = await listSourceFiles(root);
  const dirCache = new Map<string, string | null>();

  for (const rel of files) {
    const content = await readFileSafe(root, rel);
    if (!content) continue;
    const sf = parseSource(rel, content);
    if (!sf) continue;
    // Use the schema of the file's own project so per-project indexes are accurate.
    const projectDir = await findProjectDir(root, path.posix.dirname(rel), dirCache);
    const models = (projectDir !== null ? groups.byProject.get(projectDir) : undefined) ?? groups.global;
    visit(sf, sf, content, rel, models, out);
  }
  return out;
}

async function loadSchemaGroups(root: string): Promise<SchemaGroups> {
  const files = await glob("**/*.prisma", { cwd: root, ignore: ["**/node_modules/**", "**/.venv/**", "**/venv/**"], nodir: true });
  const global = new Map<string, PrismaModel>();
  const byProject = new Map<string, Map<string, PrismaModel>>();
  const dirCache = new Map<string, string | null>();

  for (const f of files) {
    const content = await readFile(path.join(root, f), "utf8").catch(() => "");
    const models = parseModels(content);
    if (models.size === 0) continue;

    for (const [key, model] of models) mergeModel(global, key, model);

    const projectDir = await findProjectDir(root, path.posix.dirname(f), dirCache);
    const bucketKey = projectDir ?? "";
    const bucket = byProject.get(bucketKey) ?? new Map<string, PrismaModel>();
    for (const [key, model] of models) mergeModel(bucket, key, model);
    byProject.set(bucketKey, bucket);
  }

  return { global, byProject };
}

function parseModels(content: string): Map<string, PrismaModel> {
  const models = new Map<string, PrismaModel>();
  const blocks = [...content.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)];
  for (const [, name, body] of blocks) {
    const indexed = new Set<string>();
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
  return models;
}

function mergeModel(target: Map<string, PrismaModel>, key: string, model: PrismaModel): void {
  const existing = target.get(key);
  if (!existing) {
    target.set(key, { name: model.name, indexed: new Set(model.indexed) });
    return;
  }
  for (const field of model.indexed) existing.indexed.add(field);
}

/** Nearest ancestor dir (relative to root) that contains a package.json, or null. */
async function findProjectDir(root: string, dir: string, cache: Map<string, string | null>): Promise<string | null> {
  if (cache.has(dir)) return cache.get(dir) ?? null;
  const trail: string[] = [];
  let cur = dir === "." ? "" : dir;
  let result: string | null = null;

  while (true) {
    const cached = cache.get(cur);
    if (cached !== undefined) {
      result = cached;
      break;
    }
    trail.push(cur);
    if (await exists(path.join(root, cur, "package.json"))) {
      result = cur;
      break;
    }
    if (cur === "") break;
    const parent = path.posix.dirname(cur);
    cur = parent === "." ? "" : parent;
  }

  for (const t of trail) cache.set(t, result);
  return result;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
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
