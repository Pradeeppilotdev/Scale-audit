import ts from "typescript";
import { lineOf, snippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";
import { Workspace } from "../workspace.js";

const SYNC_BLOCKING = new Set([
  "readFileSync",
  "writeFileSync",
  "appendFileSync",
  "existsSync",
  "readdirSync",
  "statSync",
  "lstatSync",
  "mkdirSync",
  "rmSync",
  "rmdirSync",
  "unlinkSync",
  "copyFileSync",
  "execSync",
  "execFileSync",
  "spawnSync",
  "pbkdf2Sync",
  "scryptSync",
  "gzipSync",
  "brotliCompressSync",
  "deflateSync",
]);

const IMAGE_LIBS = /\b(?:sharp|jimp|gm)\s*\(|\bimagemagick\b\s*[.(]/;

export async function detectSyncIo(root: string, ws?: Workspace): Promise<Finding[]> {
  const out: Finding[] = [];
  const workspace = ws ?? (await Workspace.load(root));
  for (const unit of workspace.units) {
    const { rel, content, sf } = unit;

    const isScript = /(^|\/)(scripts?|tools?|bin|seed|migrations?|fixtures?|examples?)\//i.test(rel) || /\.config\.|webpack\.config|rollup\.config|vite\.config/i.test(rel);
    const hotPath = isRequestPath(rel) && !isScript;

    visitSync(sf, sf, content, rel, out, hotPath, isScript);

    if (IMAGE_LIBS.test(content) && hotPath) {
      const ln = findLine(content, IMAGE_LIBS);
      if (ln) {
        out.push(
          makeFinding({
            id: "image-processing-in-request",
            category: "I/O",
            severity: "medium",
            confidence: "low",
            file: rel,
            line: ln,
            message: "Image processing appears in a request-path file.",
            scaleTrigger: "CPU-bound image work blocks the event loop per request.",
            suggestedFix: "Offload image processing to a background job / worker queue and cache results.",
            snippet: snippetAt(content, ln),
          }),
        );
      }
    }
  }
  return out;
}

function visitSync(node: ts.Node, sf: ts.SourceFile, content: string, rel: string, out: Finding[], hotPath: boolean, isScript: boolean) {
  if (ts.isCallExpression(node)) {
    const name =
      ts.isPropertyAccessExpression(node.expression) ? node.expression.name.getText() : ts.isIdentifier(node.expression) ? node.expression.text : "";
    if (SYNC_BLOCKING.has(name) || /(FileSync|DirSync)$/.test(name)) {
      const ln = lineOf(sf, node);
      const inFunction = isInsideFunction(node);
      const startup = !inFunction && !isScript;
      const severity = isScript || startup ? "low" : hotPath ? "high" : "medium";
      const confidence = isScript || startup ? "low" : hotPath ? "medium" : "low";
      const message = startup
        ? `Synchronous call "${name}" runs at module scope (startup/config).`
        : `Synchronous call "${name}" blocks the event loop.`;
      const scaleTrigger = isScript
        ? "Script sync call; not a runtime bottleneck unless run in a request path."
        : startup
          ? "Startup sync call; fine once at boot, dangerous if imported into a request path."
          : "Under concurrency, sync calls stall all requests.";
      const suggestedFix = isScript || startup
        ? "Keep at startup only; never call from request handlers."
        : "Replace with the async equivalent and ensure the hot path stays non-blocking.";
      out.push(
        makeFinding({
          id: "sync-io",
          category: "I/O",
          severity,
          confidence,
          file: rel,
          line: ln,
          message,
          scaleTrigger,
          suggestedFix,
          snippet: snippetAt(content, ln),
        }),
      );
    }
  }
  ts.forEachChild(node, (c) => visitSync(c, sf, content, rel, out, hotPath, isScript));
}

function isInsideFunction(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isGetAccessorDeclaration(cur) ||
      ts.isSetAccessorDeclaration(cur) ||
      ts.isConstructorDeclaration(cur)
    ) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

function findLine(content: string, re: RegExp): number | null {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return null;
}

/**
 * Directory/file names that indicate a request path.
 *
 * This used to be a substring match on the whole path (`/route|controller|handler|
 * server|app|api/i`), which classified `capitalize.ts` (contains "api") and every
 * file in a monorepo's `apps/` folder as a hot path. Matching whole path segments
 * removes that noise.
 */
const REQUEST_PATH_SEGMENTS = new Set([
  "route",
  "routes",
  "controller",
  "controllers",
  "handler",
  "handlers",
  "api",
  "apis",
  "endpoint",
  "endpoints",
  "resolver",
  "resolvers",
  "pages",
  "middleware",
  "server",
  "servers",
  "app",
  "view",
  "views",
]);

export function isRequestPath(rel: string): boolean {
  const segments = rel.split("/");
  const last = segments[segments.length - 1] ?? "";
  const base = last.replace(/\.[^.]+$/, "");
  if (REQUEST_PATH_SEGMENTS.has(base.toLowerCase())) return true;
  for (const seg of segments.slice(0, -1)) {
    if (REQUEST_PATH_SEGMENTS.has(seg.toLowerCase())) return true;
  }
  return false;
}
