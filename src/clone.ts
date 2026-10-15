import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

export interface CloneResult {
  root: string;
  commit: string | null;
  cleanup: () => Promise<void>;
}

export function isRemote(input: string): boolean {
  return /^https?:\/\//.test(input) || /^git@/.test(input);
}

export async function resolveRepo(input: string): Promise<CloneResult> {
  if (!isRemote(input)) {
    const root = path.resolve(input);
    const commit = await tryCommit(root);
    return { root, commit, cleanup: async () => {} };
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
