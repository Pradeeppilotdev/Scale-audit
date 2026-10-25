import fs, { constants, type Stats } from "node:fs";
import { open, opendir } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_MAX_FILE_BYTES = 1_000_000;
export const MAX_SOURCE_BYTES = 20_000_000;
export const MAX_SCHEMA_BYTES = 10_000_000;
export const MAX_MANIFEST_BYTES = 5_000_000;

function validLimit(maxBytes: number): boolean {
  return Number.isSafeInteger(maxBytes) && maxBytes >= 0 && maxBytes < Number.MAX_SAFE_INTEGER;
}

function relativeParts(rel: string): string[] | null {
  // Reject foreign-platform absolute paths and separators as well as native ones.
  if (!rel || rel.includes("\0") || rel.includes("\\") || path.isAbsolute(rel) || path.win32.isAbsolute(rel) || /^[a-z]:/i.test(rel)) return null;
  const parts = rel.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) return null;
  return parts;
}

function contained(root: string, full: string): boolean {
  const rel = path.relative(root, full);
  return rel !== "" && !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

interface CheckedPath {
  root: string;
  full: string;
  stat: Stats;
}

function checkPath(root: string, rel: string, directory = false): CheckedPath | null {
  const parts = relativeParts(rel);
  if (!parts) return null;
  // Resolve the root once: /var on macOS (and user-provided root aliases) is valid.
  const realRoot = fs.realpathSync(root);
  if (!fs.statSync(realRoot).isDirectory()) return null;
  let full = realRoot;
  let stat: Stats | undefined;
  for (let i = 0; i < parts.length; i++) {
    full = path.join(full, parts[i]);
    stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) return null;
    if (i < parts.length - 1 || directory) {
      if (!stat.isDirectory()) return null;
    } else if (!stat.isFile()) return null;
    if (!contained(realRoot, fs.realpathSync(full))) return null;
  }
  return stat ? { root: realRoot, full, stat } : null;
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function validFile(st: Stats, checked: CheckedPath, maxBytes: number): boolean {
  return st.isFile() && st.size <= maxBytes && sameFile(st, checked.stat);
}

function unchanged(root: string, rel: string, before: Stats, after: Stats, maxBytes: number): boolean {
  const checked = checkPath(root, rel);
  return checked !== null && validFile(after, checked, maxBytes) && sameFile(before, after)
    && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

// NONBLOCK prevents a raced-in FIFO from hanging open before fstat can reject it.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const CHUNK_BYTES = 64 * 1024;

/** Decode BOM-marked TypeScript text only after bounded descriptor validation. */
function decodeRepoText(bytes: Buffer, allowUtf16 = true): string | null {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    if (!allowUtf16 || (bytes.length - 2) % 2 !== 0) return null;
    const text = bytes.subarray(2);
    if (bytes[0] === 0xff) return text.toString("utf16le");
    return Buffer.from(text).swap16().toString("utf16le");
  }
  // Retain the UTF-8 BOM so existing codemod byte comparisons preserve it.
  return bytes.toString("utf8");
}

/** Bounded, regular-file-only read. Unsafe, missing and over-limit files return null. */
export function readRepoFileSync(root: string, rel: string, maxBytes = DEFAULT_MAX_FILE_BYTES, allowUtf16 = true): string | null {
  if (!validLimit(maxBytes)) return null;
  let fd: number | undefined;
  try {
    const checked = checkPath(root, rel);
    if (!checked || checked.stat.size > maxBytes) return null;
    fd = fs.openSync(checked.full, READ_FLAGS);
    const before = fs.fstatSync(fd);
    if (!validFile(before, checked, maxBytes) || !unchanged(checked.root, rel, before, before, maxBytes)) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, maxBytes + 1 - total));
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) return null;
      chunks.push(chunk.subarray(0, n));
    }
    if (!unchanged(checked.root, rel, before, fs.fstatSync(fd), maxBytes)) return null;
    return decodeRepoText(Buffer.concat(chunks, total), allowUtf16);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Async counterpart with the same validation and bounded descriptor reads. */
export async function readRepoFile(root: string, rel: string, maxBytes = DEFAULT_MAX_FILE_BYTES): Promise<string | null> {
  if (!validLimit(maxBytes)) return null;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const checked = checkPath(root, rel);
    if (!checked || checked.stat.size > maxBytes) return null;
    handle = await open(checked.full, READ_FLAGS);
    const before = await handle.stat();
    if (!validFile(before, checked, maxBytes) || !unchanged(checked.root, rel, before, before, maxBytes)) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, maxBytes + 1 - total));
      const { bytesRead: n } = await handle.read(chunk, 0, chunk.length, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) return null;
      chunks.push(chunk.subarray(0, n));
    }
    if (!unchanged(checked.root, rel, before, await handle.stat(), maxBytes)) return null;
    return decodeRepoText(Buffer.concat(chunks, total));
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

export class RepoInputBudget {
  private used = 0;

  constructor(private readonly label: string, private readonly maxBytes: number) {}

  add(content: string): void {
    this.used += Buffer.byteLength(content, "utf8");
    if (this.used > this.maxBytes) throw new Error(`Repository ${this.label} input exceeds aggregate limit of ${this.maxBytes} bytes`);
  }
}

export interface RepoEntry {
  rel: string;
  directory: boolean;
}

/** Stream entries rather than materializing an unbounded glob before applying caps. */
export async function* walkRepo(root: string, options: {
  ignore?: (rel: string, directory: boolean) => boolean;
  maxEntries?: number;
  maxDepth?: number;
} = {}): AsyncGenerator<RepoEntry> {
  const realRoot = fs.realpathSync(root);
  const maxEntries = options.maxEntries ?? 100_000;
  const maxDepth = options.maxDepth ?? 128;
  let seen = 0;
  async function* visit(dir: string, depth: number): AsyncGenerator<RepoEntry> {
    if (depth > maxDepth) throw new Error(`Repository traversal exceeds depth limit of ${maxDepth}`);
    const checked = dir ? checkPath(realRoot, dir, true) : null;
    if (dir && !checked) return;
    const handle = await opendir(checked?.full ?? realRoot);
    for await (const entry of handle) {
      if (++seen > maxEntries) throw new Error(`Repository traversal exceeds entry limit of ${maxEntries}`);
      // Match glob's default dot:false behavior; CI metadata is checked separately.
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      const directory = entry.isDirectory();
      if (options.ignore?.(rel, directory)) continue;
      if (!directory && !entry.isFile()) continue;
      yield { rel, directory };
      if (directory) yield* visit(rel, depth + 1);
    }
  }
  yield* visit("", 0);
}

/** Check CI metadata without following symlink files or parent directories. */
export function repoPathExists(root: string, rel: string, directory = false): boolean {
  try {
    return checkPath(root, rel, directory) !== null;
  } catch {
    return false;
  }
}

export function parseRepoManifest(content: string | null): Record<string, unknown> {
  if (content === null) return {};
  try {
    const value: unknown = JSON.parse(content);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
