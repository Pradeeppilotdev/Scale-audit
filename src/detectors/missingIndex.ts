import { readFile } from "node:fs/promises";
import path from "node:path";
import { glob } from "glob";
import ts from "typescript";
import { listSourceFiles, readFileSafe, parseSource, lineOf, snippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";

export async function detectMissingIndexes(root: string): Promise<Finding[]> {
  const indexed = await loadIndexedFields(root);
  if (indexed.size === 0) return []; // no schema -> no reliable signal
  const out: Finding[] = [];
  const files = await listSourceFiles(root);
  for (const rel of files) {
    const content = await readFileSafe(root, rel);
    if (!content) continue;
    const sf = parseSource(rel, content);
    if (!sf) continue;
    visit(sf, sf, content, rel, indexed, out);
  }
  return out;
}

async function loadIndexedFields(root: string): Promise<Set<string>> {
  const files = await glob("**/*.prisma", { cwd: root, ignore: ["**/node_modules/**"], nodir: true });
  const out = new Set<string>();
  for (const f of files) {
    const content = await readFile(path.join(root, f), "utf8").catch(() => "");
    // crude parse: capture @id, @unique, and @@index([...]) / @@unique([...])
    const lines = content.split("\n");
    for (const line of lines) {
      const idm = line.match(/(\w+)\s+\w+.*@id\b/);
      if (idm) out.add(idm[1]);
      const unm = line.match(/(\w+)\s+\w+.*@unique\b/);
      if (unm) out.add(unm[1]);
    }
    // block-level index
    const blockIdx = [...content.matchAll(/@@(?:index|unique)\(\s*\[([^\]]+)\]/g)];
    for (const m of blockIdx) {
      for (const field of m[1].split(",")) {
        const name = field.trim().split(/\s/)[0];
        if (name) out.add(name);
      }
    }
  }
  return out;
}

function visit(node: ts.Node, sf: ts.SourceFile, content: string, rel: string, indexed: Set<string>, out: Finding[]) {
  if (ts.isPropertyAssignment(node) && node.name.getText().replace(/['"]/g, "") === "where") {
    const val = node.initializer;
    if (ts.isObjectLiteralExpression(val)) {
      for (const p of val.properties) {
        if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
          const field = p.name.getText().replace(/['"]/g, "");
          if (field && !indexed.has(field)) {
            const ln = lineOf(sf, node);
            out.push(
              makeFinding({
                id: "missing-index",
                category: "DB",
                severity: "medium",
                confidence: "low",
                file: rel,
                line: ln,
                message: `Query filters on "${field}", which is not declared as @id/@unique/@@index in the Prisma schema. Verify an index exists.`,
                scaleTrigger: "Unindexed filter becomes a full table scan as rows grow.",
                suggestedFix: `Add an index for the filter column (\`@@index([${field}])\` or \`@unique\`) if this query runs frequently, or constrain the filter.`,
                snippet: snippetAt(content, ln),
              }),
            );
          }
        }
      }
    }
  }
  ts.forEachChild(node, (c) => visit(c, sf, content, rel, indexed, out));
}
