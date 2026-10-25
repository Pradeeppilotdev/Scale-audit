import {
  MAX_MANIFEST_BYTES, RepoInputBudget, isRecord, parseRepoManifest, readRepoFile, repoPathExists, walkRepo,
} from "./repoFiles.js";
import type { Fingerprint, ProjectType } from "./types.js";
import { listSourceFiles } from "./detectors/common.js";

export async function fingerprintRepo(root: string, sourceFile?: string): Promise<Fingerprint> {
  const budget = new RepoInputBudget("manifest", MAX_MANIFEST_BYTES);
  const rootContent = await readRepoFile(root, "package.json");
  if (rootContent !== null) budget.add(rootContent);
  const pkg = parseRepoManifest(rootContent);

  // Monorepos keep the interesting dependencies in workspace packages, so
  // every package.json in the repo is folded in.
  const workspacePkgs = await readWorkspacePackages(root, budget);
  const deps = mergeDeps([pkg, ...workspacePkgs], "dependencies");
  const devDeps = mergeDeps([pkg, ...workspacePkgs], "devDependencies");
  const allDeps = { ...deps, ...devDeps };

  const framework = detectFramework(allDeps);
  const orm = detectOrm(allDeps);

  const sourceFiles = sourceFile ? [sourceFile] : await listSourceFiles(root);

  const hasTests =
    (await hasTestFiles(root)) ||
    Boolean(devDeps.jest || devDeps.vitest || devDeps.mocha || devDeps["node-tap"] || deps["@jest/globals"]);
  const hasCI = repoPathExists(root, ".github/workflows", true) || repoPathExists(root, ".gitlab-ci.yml");

  return {
    framework,
    orm,
    hasTests,
    hasCI,
    deps,
    devDeps,
    fileCount: sourceFile ? 1 : await countAllFiles(root),
    sourceFileCount: sourceFiles.length,
    projectType: detectProjectType(pkg, mergeDeps([pkg], "dependencies")),
  };
}

/** Every package.json in the repo except the root one. */
async function readWorkspacePackages(root: string, budget: RepoInputBudget): Promise<Record<string, unknown>[]> {
  // Fixtures and examples must not contribute dependencies to the audited project.
  const ignored = new Set([
    "node_modules", "dist", "build", "coverage", "test", "tests", "__tests__", "fixtures",
    "__fixtures__", "examples", "example", "docs",
  ]);
  const pkgs: Record<string, unknown>[] = [];
  let count = 0;
  for await (const { rel, directory } of walkRepo(root, {
    ignore: (rel, directory) => (directory && ignored.has(rel.split("/").at(-1)!)) || /\.(test|spec)\./.test(rel),
  })) {
    if (directory || rel === "package.json" || !rel.endsWith("/package.json")) continue;
    if (++count > 2_000) throw new Error("Repository workspace manifest count exceeds limit of 2000");
    const content = await readRepoFile(root, rel);
    if (content === null) continue;
    budget.add(content);
    pkgs.push(parseRepoManifest(content));
  }
  return pkgs;
}

function mergeDeps(pkgs: Record<string, unknown>[], key: "dependencies" | "devDependencies"): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const p of pkgs) {
    const section = p?.[key];
    if (!isRecord(section)) continue;
    for (const [name, version] of Object.entries(section)) {
      if (typeof version === "string") out[name] = version;
    }
  }
  return out;
}

const SERVER_FRAMEWORKS = ["express", "fastify", "next", "@nestjs/core", "koa", "@hapi/hapi", "hapi", "@sveltejs/kit", "nuxt"];

/**
 * Is this an application or a library?
 *
 * The scale-readiness score means something different for each. A library is
 * judged by its API design; an application is judged by how it behaves under
 * load. Reporting "this library has unbounded reads" is noise.
 *
 * Only the root package's own runtime dependencies are considered: a library
 * commonly has a server framework in its devDependencies for benchmarks, and
 * a monorepo's workspace packages are not what the root package is.
 */
function detectProjectType(pkg: Record<string, unknown>, runtimeDeps: Record<string, string>): ProjectType {
  if (SERVER_FRAMEWORKS.some((f) => f in runtimeDeps)) return "application";
  if (pkg?.private === true) return "application";
  // A CLI is deployed and run, not consumed as a library.
  if (pkg?.bin) return "application";
  const isPublishable = Boolean(pkg?.main || pkg?.exports || pkg?.module || pkg?.types);
  if (isPublishable) return "library";
  return "unknown";
}

function detectFramework(deps: Record<string, string>): string | null {
  if (deps.next) return "Next.js";
  if (deps["@nestjs/core"]) return "NestJS";
  if (deps.fastify) return "Fastify";
  if (deps.koa) return "Koa";
  if (deps["@hapi/hapi"] || deps.hapi) return "Hapi";
  if (deps.express) return "Express";
  return null;
}

function detectOrm(deps: Record<string, string>): string | null {
  if (deps.prisma || deps["@prisma/client"]) return "Prisma";
  if (deps.typeorm) return "TypeORM";
  if (deps.sequelize) return "Sequelize";
  if (deps.mongoose) return "Mongoose";
  if (deps["drizzle-orm"]) return "Drizzle";
  if (deps.kysely) return "Kysely";
  return null;
}


/**
 * Does the repo have tests?
 *
 * Test files are excluded from the source list the detectors read, so they
 * have to be looked up separately.
 */
async function hasTestFiles(root: string): Promise<boolean> {
  for await (const { rel, directory } of walkRepo(root, {
    ignore: (rel, directory) => directory && ["node_modules", "dist"].includes(rel.split("/").at(-1)!),
  })) {
    if (directory && ["test", "tests", "__tests__"].includes(rel.split("/").at(-1)!)) return true;
    if (!directory && /\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(rel) && !rel.split("/").some((part) => ["build", "coverage"].includes(part))) return true;
  }
  return false;
}

async function countAllFiles(root: string): Promise<number> {
  let count = 0;
  for await (const { directory } of walkRepo(root, {
    ignore: (rel, directory) => directory && rel.split("/").at(-1) === "node_modules",
  })) {
    if (!directory) count++;
  }
  return count;
}
