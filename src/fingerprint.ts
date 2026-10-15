import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { glob } from "glob";
import type { Fingerprint } from "./types.js";

export async function fingerprintRepo(root: string): Promise<Fingerprint> {
  const pkgPath = path.join(root, "package.json");
  let pkg: any = {};
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  } catch {
    pkg = {};
  }
  const deps = pkg.dependencies ?? {};
  const devDeps = pkg.devDependencies ?? {};
  const allDeps = { ...deps, ...devDeps };

  const framework = detectFramework(allDeps, root);
  const orm = detectOrm(allDeps, root);

  const sourceFiles = await glob("**/*.{ts,tsx,js,jsx,mjs,cjs}", {
    cwd: root,
    ignore: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.git/**",
      "**/coverage/**",
      "**/examples/**",
      "**/docs/**",
      "**/benchmarks/**",
      "**/.next/**",
      "**/.nuxt/**",
      "**/.svelte-kit/**",
      "**/.turbo/**",
      "**/.vercel/**",
      "**/.output/**",
      "**/.cache/**",
      "**/.venv/**",
      "**/venv/**",
    ],
    nodir: true,
    follow: false,
  });

  const hasTests = sourceFiles.some((f) => /(\.test\.|\.spec\.|__tests__)/.test(f)) || Boolean(devDeps.jest || devDeps.vitest || devDeps.mocha);
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
  };
}

function detectFramework(deps: Record<string, string>, root: string): string | null {
  if (deps.next) return "Next.js";
  if (deps["@nestjs/core"]) return "NestJS";
  if (deps.fastify) return "Fastify";
  if (deps.koa) return "Koa";
  if (deps["@hapi/hapi"] || deps.hapi) return "Hapi";
  if (deps.express) return "Express";
  return null;
}

function detectOrm(deps: Record<string, string>, root: string): string | null {
  if (deps.prisma || deps["@prisma/client"]) return "Prisma";
  if (deps.typeorm) return "TypeORM";
  if (deps.sequelize) return "Sequelize";
  if (deps.mongoose) return "Mongoose";
  if (deps["drizzle-orm"]) return "Drizzle";
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

async function countAllFiles(root: string): Promise<number> {
  const files = await glob("**/*", { cwd: root, ignore: ["**/node_modules/**", "**/.git/**"], nodir: true });
  return files.length;
}
