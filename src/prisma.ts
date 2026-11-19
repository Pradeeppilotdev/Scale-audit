import path from "node:path";
import { MAX_MANIFEST_BYTES, MAX_SCHEMA_BYTES, RepoInputBudget, readRepoFile, repoPathExists, walkRepo } from "./repoFiles.js";

export interface PrismaModel {
  name: string;
  /** Fields that can serve as a standalone index for a single-column filter. */
  indexed: Set<string>;
  /** Scalar schema fields, used to distinguish filters from relation objects. */
  scalarFields?: Set<string>;
  nullableScalarFields?: Set<string>;
}

export interface SchemaGroups {
  /** Union of all schemas: fallback when a code file has no scoped schema. */
  global: Map<string, PrismaModel>;
  /** Keyed by project dir (nearest package.json above the schema); "" when none. */
  byProject: Map<string, Map<string, PrismaModel>>;
}

export async function loadSchemaGroups(root: string): Promise<SchemaGroups> {
  const files: string[] = [];
  for await (const { rel, directory } of walkRepo(root, {
    ignore: (rel, directory) => directory && ["node_modules", "venv"].includes(rel.split("/").at(-1)!),
  })) {
    if (!directory && rel.endsWith(".prisma")) {
      files.push(rel);
      if (files.length > 1_000) throw new Error("Repository schema file count exceeds limit of 1000");
    }
  }
  const global = new Map<string, PrismaModel>();
  const byProject = new Map<string, Map<string, PrismaModel>>();
  const dirCache = new Map<string, string | null>();

  const budget = new RepoInputBudget("schema", MAX_SCHEMA_BYTES);
  for (const f of files) {
    const content = await readRepoFile(root, f);
    if (content === null) continue;
    budget.add(content);
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

/** Lower-cased model names across every schema, for context lookups. */
export function schemaModelNames(groups: SchemaGroups): Set<string> {
  return new Set(groups.global.keys());
}

/** Consume each literal/comment once, including malformed unterminated strings.
 * A combined regex can retry every escaped quote and do quadratic work. */
function maskSchemaLiterals(content: string): string {
  const pieces: string[] = [];
  let position = 0, copied = 0;
  while (position < content.length) {
    const start = position;
    if (content[position] === '"') {
      position++;
      while (position < content.length) {
        const character = content[position++];
        if (character === "\\") position = Math.min(position + 1, content.length);
        else if (character === '"') break;
      }
    } else if (content.startsWith("//", position)) {
      const end = content.indexOf("\n", position + 2);
      position = end < 0 ? content.length : end;
    } else if (content.startsWith("/*", position)) {
      const end = content.indexOf("*/", position + 2);
      position = end < 0 ? content.length : end + 2;
    } else { position++; continue; }
    pieces.push(content.slice(copied, start), content.slice(start, position).replace(/[^\n]/g, " "));
    copied = position;
  }
  pieces.push(content.slice(copied));
  return pieces.join("");
}

export function parseModels(content: string): Map<string, PrismaModel> {
  const models = new Map<string, PrismaModel>();
  // Attribute spellings in comments or string defaults are not schema indexes.
  // Preserve newlines so each real field retains its declaration boundary.
  const clean = maskSchemaLiterals(content);
  const blocks = clean.matchAll(/\bmodel\s+(\w+)\s*\{([^{}]*)\}/g);
  for (const [, name, body] of blocks) {
    const indexed = new Set<string>();
    const scalarFields = new Set<string>();
    const nullableScalarFields = new Set<string>();
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      const field = /^(\w+)\s+(?:String|Int|BigInt|Float|Decimal|Boolean|DateTime|Bytes|Json)(\?|\[\])?(?=\s|$)/.exec(trimmed);
      if (field) {
        scalarFields.add(field[1]);
        if (field[2] === "?") nullableScalarFields.add(field[1]);
      }
      const idm = trimmed.match(/^(\w+)\s+\w+.*@id\b/);
      if (idm) indexed.add(idm[1]);
      const unm = trimmed.match(/^(\w+)\s+\w+.*@unique\b/);
      if (unm) indexed.add(unm[1]);
    }
    const indexes = /@@(?:id|index|unique)\s*\(\s*\[/g;
    for (let match = indexes.exec(body); match; match = indexes.exec(body)) {
      const end = body.indexOf("]", indexes.lastIndex);
      if (end < 0) break;
      // Only the leading column serves a standalone single-column filter.
      // Field arguments (sort/length/ops) do not form part of its name.
      const first = /^\s*(\w+)/.exec(body.slice(indexes.lastIndex, end));
      if (first) indexed.add(first[1]);
      indexes.lastIndex = end + 1;
    }
    models.set(name.toLowerCase(), { name, indexed, scalarFields, nullableScalarFields });
  }
  return models;
}

export function mergeModel(target: Map<string, PrismaModel>, key: string, model: PrismaModel): void {
  const existing = target.get(key);
  if (!existing) {
    target.set(key, { name: model.name, indexed: new Set(model.indexed), scalarFields: new Set(model.scalarFields),
      nullableScalarFields: new Set(model.nullableScalarFields) });
    return;
  }
  for (const field of model.scalarFields ?? []) existing.scalarFields?.add(field);
  for (const field of model.nullableScalarFields ?? []) existing.nullableScalarFields?.add(field);
  for (const field of model.indexed) existing.indexed.add(field);
}

const projectManifestBudgets = new WeakMap<Map<string, string | null>, RepoInputBudget>();

/** Nearest ancestor dir (relative to root) that contains a package.json, or null. */
export async function findProjectDir(root: string, dir: string, cache: Map<string, string | null>): Promise<string | null> {
  if (dir !== "" && dir !== "." && !repoPathExists(root, dir, true)) return null;
  if (cache.has(dir)) return cache.get(dir) ?? null;
  let budget = projectManifestBudgets.get(cache);
  if (!budget) {
    budget = new RepoInputBudget("project manifest", MAX_MANIFEST_BYTES);
    projectManifestBudgets.set(cache, budget);
  }
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
    const manifest = await readRepoFile(root, cur ? `${cur}/package.json` : "package.json");
    if (manifest !== null) {
      budget.add(manifest);
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
