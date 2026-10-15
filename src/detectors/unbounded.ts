import ts from "typescript";
import { listSourceFiles, readFileSafe, parseSource, lineOf, snippetAt, makeFinding, isOrmCall } from "./common.js";
import type { Finding } from "../types.js";

const UNIQUE_METHODS = new Set(["findUnique", "findUniqueOrThrow", "findOne", "findByPk", "findByID", "findById"]);
const PAGINATION_KEYS = new Set(["take", "limit", "skip", "cursor", "top", "first", "pageSize", "perPage", "offset", "start", "end"]);

export async function detectUnboundedReads(root: string): Promise<Finding[]> {
  const out: Finding[] = [];
  const files = await listSourceFiles(root);
  for (const rel of files) {
    const content = await readFileSafe(root, rel);
    if (!content) continue;
    const sf = parseSource(rel, content);
    if (!sf) continue;
    visit(sf, sf, content, rel, out);
  }
  return out;
}

function visit(node: ts.Node, sf: ts.SourceFile, content: string, rel: string, out: Finding[]) {
  if (ts.isCallExpression(node) && isOrmCall(node)) {
    const methodName = methodNameOf(node.expression);
    if (!UNIQUE_METHODS.has(methodName)) {
      if (!hasPagination(node)) {
        const ln = lineOf(sf, node);
        out.push(
          makeFinding({
            id: "unbounded-read",
            category: "DB",
            severity: "high",
            confidence: "medium",
            file: rel,
            line: ln,
            message: `Database read "${methodName}" appears to have no pagination (take/limit/cursor/skip).`,
            scaleTrigger: "Returns the full table/collection; memory and latency grow with data size.",
            suggestedFix: "Add bounded pagination (take + cursor/skip) with a sensible default cap and enforce max page size.",
            snippet: snippetAt(content, ln),
          }),
        );
      }
    }
  }
  ts.forEachChild(node, (c) => visit(c, sf, content, rel, out));
}

function methodNameOf(expr: ts.Expression): string {
  if (ts.isPropertyAccessExpression(expr)) return expr.name.getText();
  if (ts.isIdentifier(expr)) return expr.text;
  return "";
}

function hasPagination(node: ts.CallExpression): boolean {
  if (node.arguments.length === 0) return false;
  const arg = node.arguments[0];
  // for SQL query strings, can't tell
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) || ts.isTemplateExpression(arg)) {
    // crude: check for LIMIT in template string
    const text = arg.getText();
    return /limit/i.test(text);
  }
  if (!ts.isObjectLiteralExpression(arg)) return false;
  return arg.properties.some((p) => {
    if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
      const name = p.name.getText().replace(/['"]/g, "");
      return PAGINATION_KEYS.has(name);
    }
    return false;
  });
}
