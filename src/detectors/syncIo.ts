import { executionContexts, type ExecutionContext } from "../executionContext.js";
import { currentImportedBinding, symbolOf } from "../bindings.js";
import ts from "typescript";
import { locationOf, sourceSnippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";
import { Workspace } from "../workspace.js";
import { requestReachability, type RequestReachability } from "../requestReachability.js";

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

const IMAGE_PACKAGES = new Set(["sharp", "jimp", "gm", "imagemagick"]);
const IMAGE_OPERATIONS = new Set(["read", "fromBuffer", "convert", "resize", "identify", "mogrify", "composite"]);

function imageCall(expression: ts.Expression): boolean {
  const direct = ts.isIdentifier(expression);
  const member = ts.isPropertyAccessExpression(expression) ? expression.name.text
    : ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression) ? expression.argumentExpression.text : undefined;
  if (!direct && member !== "default" && (!member || !IMAGE_OPERATIONS.has(member))) return false;
  const imported = currentImportedBinding(expression);
  if (imported && IMAGE_PACKAGES.has(imported.module)) {
    return imported.name === "default" || imported.name === "*" || IMAGE_OPERATIONS.has(imported.name);
  }
  if (direct) return IMAGE_PACKAGES.has(expression.text) && !symbolOf(expression)?.declarations?.length;
  if (member && (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))) {
    const receiver = expression.expression;
    const binding = currentImportedBinding(receiver);
    if (binding?.module === "jimp" && binding.name === "Jimp") return IMAGE_OPERATIONS.has(member);
    return ts.isIdentifier(receiver) && IMAGE_PACKAGES.has(receiver.text) && !symbolOf(receiver)?.declarations?.length;
  }
  return false;
}

export async function detectSyncIo(root: string, ws?: Workspace): Promise<Finding[]> {
  const out: Finding[] = [];
  const workspace = ws ?? (await Workspace.load(root));
  const contexts = await executionContexts(root, workspace, isRequestPath);
  const requests = requestReachability(workspace);
  for (const unit of workspace.units) {
    const { rel, sf } = unit;

    const isScript = /(^|\/)(scripts?|tools?|bin|seed|migrations?|fixtures?|examples?)\//i.test(rel) || /\.config\.|webpack\.config|rollup\.config|vite\.config/i.test(rel);
    const context = contexts.get(rel);
    const hotPath = context?.request ?? false;

    visitSync(sf, sf, rel, out, hotPath, isScript, context, requests);
  }
  return out;
}

function visitSync(node: ts.Node, sf: ts.SourceFile, rel: string, out: Finding[], hotPath: boolean, isScript: boolean, context: ExecutionContext | undefined, requests: RequestReachability) {
  if (ts.isCallExpression(node)) {
    const request = requests.evidence(node);
    if (request && imageCall(node.expression)) {
      const location = locationOf(sf, node);
      out.push(makeFinding({
        id: "image-processing-in-request", category: "I/O", severity: "medium", confidence: "low",
        file: rel, ...location, message: "A request path can invoke an image-processing library.",
        scaleTrigger: "Concurrent image processing can consume CPU, worker capacity and memory as requests increase.",
        suggestedFix: "Cache repeated transformations and bound concurrent image jobs.",
        snippet: sourceSnippetAt(sf, location.line),
      }));
    }
    let name =
      ts.isPropertyAccessExpression(node.expression) ? node.expression.name.getText() : ts.isIdentifier(node.expression) ? node.expression.text : "";
    const imported = currentImportedBinding(node.expression);
    if (imported && /^(node:)?(fs(?:\/promises)?|child_process|crypto|zlib)$/.test(imported.module)) name = imported.name;
    if ((SYNC_BLOCKING.has(name) || /(FileSync|DirSync)$/.test(name))
      && !requests.localSyncImplementation(node)) {
      const location = locationOf(sf, node);
      const reached = request === "request";
      const inFunction = isInsideFunction(node);
      const startup = !inFunction && !isScript && !reached;
      const isolated = !hotPath && !request && (context?.cli || context?.worker);
      const label = context?.cli && context?.worker ? "CLI/isolated worker" : context?.worker ? "isolated worker" : "CLI";
      const severity = isolated ? "info" : startup ? "low" : reached ? "high" : isScript ? "low" : "medium";
      const confidence = isolated ? "medium" : startup ? "low" : reached ? "medium" : "low";
      const message = isolated
        ? `Synchronous call "${name}" runs in ${label} code (based on module reachability).`
        : startup
        ? `Synchronous call "${name}" runs at module scope (startup/config).`
        : `Synchronous call "${name}" blocks the event loop.`;
      const scaleTrigger = isolated
        ? "Blocks this CLI/worker execution; no request-entry import path was found in the analyzed source. Slow storage can still delay the audit."
        : reached && !startup
          ? "This call is reachable from a request entry through a request callback or invoked helper; synchronous I/O can stall concurrent requests."
          : request === "possible"
          ? "This callback may execute as work originating from a request; external callback invocation could not be resolved."
          : hotPath && !startup
          ? "No function-level request call path was established. Importing this module alone does not show that this synchronous call executes per request."
          : isScript
        ? "Script sync call; not a runtime bottleneck unless run in a request path."
        : startup
          ? "Startup sync call; fine once at boot, dangerous if imported into a request path."
          : "Under concurrency, sync calls stall all requests.";
      const suggestedFix = isolated
        ? "Keep safety checks intact. Optimize only if profiling shows a bottleneck; reassess if this code is imported into a request handler."
        : (isScript && !hotPath) || startup
        ? "Keep at startup only; never call from request handlers."
        : "Replace with the async equivalent and ensure the hot path stays non-blocking.";
      out.push(
        makeFinding({
          id: "sync-io",
          category: "I/O",
          severity,
          confidence,
          file: rel,
          ...location,
          message,
          scaleTrigger,
          suggestedFix,
          snippet: sourceSnippetAt(sf, location.line),
        }),
      );
    }
  }
  ts.forEachChild(node, (c) => visitSync(c, sf, rel, out, hotPath, isScript, context, requests));
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
      ts.isConstructorDeclaration(cur) ||
      ts.isPropertyDeclaration(cur) && !cur.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)
    ) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
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
