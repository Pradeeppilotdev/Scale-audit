import ts from "typescript";
import { listSourceFiles, readFileSafe, parseSource, lineOf, snippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";

const SYNC_METHODS = /(Sync|Sync$)/;
const IMAGE_LIBS = /\b(sharp|jimp|gm|imagemagick)\b/;

export async function detectSyncIo(root: string): Promise<Finding[]> {
  const out: Finding[] = [];
  const files = await listSourceFiles(root);
  for (const rel of files) {
    const content = await readFileSafe(root, rel);
    if (!content) continue;
    const sf = parseSource(rel, content);
    if (!sf) continue;
    const hotPath = /route|controller|handler|server|app|api/i.test(rel);

    // sync calls
    visitSync(sf, sf, content, rel, out, hotPath);

    // image processing heuristic
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

function visitSync(node: ts.Node, sf: ts.SourceFile, content: string, rel: string, out: Finding[], hotPath: boolean) {
  if (ts.isCallExpression(node)) {
    const name =
      ts.isPropertyAccessExpression(node.expression) ? node.expression.name.getText() : ts.isIdentifier(node.expression) ? node.expression.text : "";
    if (SYNC_METHODS.test(name)) {
      const ln = lineOf(sf, node);
      out.push(
        makeFinding({
          id: "sync-io",
          category: "I/O",
          severity: hotPath ? "high" : "medium",
          confidence: hotPath ? "medium" : "low",
          file: rel,
          line: ln,
          message: `Synchronous call "${name}" blocks the event loop.`,
          scaleTrigger: "Under concurrency, sync calls stall all requests.",
          suggestedFix: "Replace with the async equivalent and ensure the hot path stays non-blocking.",
          snippet: snippetAt(content, ln),
        }),
      );
    }
  }
  ts.forEachChild(node, (c) => visitSync(c, sf, content, rel, out, hotPath));
}

function findLine(content: string, re: RegExp): number | null {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return null;
}
