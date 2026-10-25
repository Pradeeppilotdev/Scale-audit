import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, lstat, stat as followStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readRepoFile, repoPathExists } from "./repoFiles.js";

const execFileAsync = promisify(execFile);

export interface CloneResult {
  root: string;
  commit: string | null;
  sourceFile?: string;
  cleanup: () => Promise<void>;
}

export function isRemote(input: string): boolean {
  return /^https?:\/\//.test(input) || /^git@/.test(input);
}

export async function resolveRepo(input: string): Promise<CloneResult> {
  if (!isRemote(input)) {
    const full = path.resolve(input);
    let stat = await lstat(full);
    if (stat.isSymbolicLink()) {
      stat = await followStat(full);
      if (!stat.isDirectory()) throw new Error("Audit source file must not be a symbolic link");
    }
    if (!stat.isFile() && !stat.isDirectory()) throw new Error("Audit input must be a regular file or directory");
    let sourceFile = stat.isFile() ? path.basename(full) : undefined;
    if (sourceFile && (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(sourceFile) || /\.d\.(ts|mts|cts)$/.test(sourceFile))) {
      throw new Error("Unsupported source file extension");
    }
    let root = sourceFile ? path.dirname(full) : full;
    if (sourceFile) {
      root = await findProjectRoot(root);
      sourceFile = path.relative(root, full).split(path.sep).join("/");
    }
    const commit = await tryCommit(root);
    return { root, commit, sourceFile, cleanup: async () => {} };
  }
  const root = await mkdtemp(path.join(tmpdir(), "scale-audit-"));
  try {
    await execFileAsync("git", ["clone", "--depth", "50", "--single-branch", input, root], {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw new Error(`clone failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const commit = await tryCommit(root);
  return {
    root,
    commit,
    cleanup: async () => rm(root, { recursive: true, force: true }).catch(() => {}),
  };
}

async function tryCommit(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], {
      timeout: 10_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Stop at the nearest valid manifest or repository boundary, never another repo. */
async function findProjectRoot(directory: string): Promise<string> {
  let current = directory;
  while (true) {
    const content = await readRepoFile(current, "package.json");
    if (content !== null) {
      try {
        const value = JSON.parse(content);
        if (value && typeof value === "object" && !Array.isArray(value)) return current;
      } catch { /* An invalid manifest is not a project boundary. */ }
    }
    if (repoPathExists(current, ".git", true) || repoPathExists(current, ".git")) return directory;
    const parent = path.dirname(current);
    if (parent === current) return directory;
    current = parent;
  }
}
