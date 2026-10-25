import path from "node:path";
import { MAX_MANIFEST_BYTES, MAX_SCHEMA_BYTES, RepoInputBudget, readRepoFile, repoPathExists, walkRepo } from "./repoFiles.js";

export interface PrismaModel {
  name: string;
  /** Fields that can serve as a standalone index for a single-column filter. */
  indexed: Set<string>;
  /** Scalar schema fields, used to distinguish filters from relation objects. */
  scalarFields?: Set<string>;
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

export function parseModels(content: string): Map<string, PrismaModel> {
  const models = new Map<string, PrismaModel>();
  const blocks = [...content.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)];
  for (const [, name, body] of blocks) {
    const indexed = new Set<string>();
    const scalarFields = new Set<string>();
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      const field = /^(\w+)\s+(?:String|Int|BigInt|Float|Decimal|Boolean|DateTime|Bytes|Json)(?:[?\[\]]*)\b/.exec(trimmed);
      if (field) scalarFields.add(field[1]);
      const idm = trimmed.match(/^(\w+)\s+\w+.*@id\b/);
      if (idm) indexed.add(idm[1]);
      const unm = trimmed.match(/^(\w+)\s+\w+.*@unique\b/);
      if (unm) indexed.add(unm[1]);
      const blockIdx = trimmed.match(/@@(?:index|unique)\(\s*\[([^\]]+)\]/);
      if (blockIdx) {
        // A composite index @@index([a, b]) only serves a single-column filter on
        // `a` (the leading column). A filter on `b` alone still needs its own index.
        const fields = blockIdx[1].split(",").map((f) => f.trim().split(/\s/)[0]).filter(Boolean);
        if (fields.length > 0) indexed.add(fields[0]);
      }
    }
    models.set(name.toLowerCase(), { name, indexed, scalarFields });
  }
  return models;
}

export function mergeModel(target: Map<string, PrismaModel>, key: string, model: PrismaModel): void {
  const existing = target.get(key);
  if (!existing) {
    target.set(key, { name: model.name, indexed: new Set(model.indexed), scalarFields: new Set(model.scalarFields) });
    return;
  }
  for (const field of model.scalarFields ?? []) existing.scalarFields?.add(field);
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
