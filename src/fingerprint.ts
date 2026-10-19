import { readFile } from "node:fs/promises";
import path from "node:path";
import { glob } from "glob";
import type { Fingerprint, ProjectType } from "./types.js";
import { listSourceFiles } from "./detectors/common.js";

export async function fingerprintRepo(root: string): Promise<Fingerprint> {
  const pkgPath = path.join(root, "package.json");
  let pkg: any = {};
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  } catch {
    pkg = {};
  }

  // Monorepos keep the interesting dependencies in workspace packages, so
  // every package.json in the repo is folded in.
  const workspacePkgs = await readWorkspacePackages(root);
  const deps = mergeDeps([pkg, ...workspacePkgs], "dependencies");
  const devDeps = mergeDeps([pkg, ...workspacePkgs], "devDependencies");
  const allDeps = { ...deps, ...devDeps };

  const framework = detectFramework(allDeps);
  const orm = detectOrm(allDeps);

  const sourceFiles = await listSourceFiles(root);

  const hasTests =
    (await hasTestFiles(root)) ||
    Boolean(devDeps.jest || devDeps.vitest || devDeps.mocha || devDeps["node-tap"] || deps["@jest/globals"]);
  const hasCI = (await exists(path.join(root, ".github", "workflows"))) || (await exists(path.join(root, ".gitlab-ci.yml")));

  return {
    framework,
    orm,
    hasTests,
    hasCI,
    deps,
    devDeps,
    fileCount: await countAllFiles(root),
    sourceFileCount: sourceFiles.length,
    projectType: detectProjectType(pkg, pkg.dependencies ?? {}),
  };
}

/** Every package.json in the repo except the root one. */
async function readWorkspacePackages(root: string): Promise<any[]> {
  const files = await glob("**/package.json", {
    cwd: root,
    // Test fixtures contain their own package.json files with their own
    // dependencies; they must not be mistaken for the project's dependencies.
    ignore: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.git/**",
      "**/coverage/**",
      "**/test/**",
      "**/tests/**",
      "**/__tests__/**",
      "**/*.test.*",
      "**/*.spec.*",
      "**/fixtures/**",
      "**/__fixtures__/**",
      "**/examples/**",
      "**/example/**",
      "**/docs/**",
    ],
    nodir: true,
  });
  const pkgs: any[] = [];
  for (const f of files) {
    if (f === "package.json") continue;
    try {
      pkgs.push(JSON.parse(await readFile(path.join(root, f), "utf8")));
    } catch {
      // ignore unreadable manifests
    }
  }
  return pkgs;
}

function mergeDeps(pkgs: any[], key: "dependencies" | "devDependencies"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pkgs) {
    const section = p?.[key];
    if (!section || typeof section !== "object") continue;
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
function detectProjectType(pkg: any, runtimeDeps: Record<string, string>): ProjectType {
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

async function exists(p: string) {
  try {
    await (await import("node:fs/promises")).stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Does the repo have tests?
 *
 * Test files are excluded from the source list the detectors read, so they
 * have to be looked up separately.
 */
async function hasTestFiles(root: string): Promise<boolean> {
  const files = await glob("**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}", {
    cwd: root,
    ignore: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**", "**/coverage/**"],
    nodir: true,
  });
  if (files.length > 0) return true;
  const dirs = await glob("**/{test,tests,__tests__}/", { cwd: root, ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"], nodir: false });
  return dirs.length > 0;
}

async function countAllFiles(root: string): Promise<number> {
  const files = await glob("**/*", { cwd: root, ignore: ["**/node_modules/**", "**/.git/**"], nodir: true });
  return files.length;
}
