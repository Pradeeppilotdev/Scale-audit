import ts from "typescript";
import { listSourceFiles, readFileSafe, parseSource, lineOf, snippetAt, makeFinding, isOrmCall, hasChainedPagination } from "./common.js";
import type { Finding } from "../types.js";

const UNIQUE_METHODS = new Set(["findUnique", "findUniqueOrThrow", "findOne", "findByPk", "findByID", "findById", "findFirst", "findFirstOrThrow"]);
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
      const check = paginationCheck(node);
      if (check !== "bounded") {
        const unknown = check === "unknown";
        const ln = lineOf(sf, node);
        out.push(
          makeFinding({
            id: "unbounded-read",
            category: "DB",
            severity: unknown ? "medium" : "high",
            confidence: unknown ? "low" : "medium",
            file: rel,
            line: ln,
            message: unknown
              ? `Database read "${methodName}" could not be confirmed as paginated (query passed as a variable); verify take/limit/cursor is set.`
              : `Database read "${methodName}" appears to have no pagination (take/limit/cursor/skip).`,
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

type PaginationCheck = "bounded" | "unbounded" | "unknown";

function paginationCheck(node: ts.CallExpression): PaginationCheck {
  if (hasChainedPagination(node)) return "bounded";
  if (node.arguments.length === 0) return "unbounded";

  let sawObject = false;
  let sawScalarString = false;
  let sawUnverifiable = false;

  // Inspect every argument: Mongoose puts options in the 3rd arg, Prisma in the 1st.
  for (const arg of node.arguments) {
    if (ts.isObjectLiteralExpression(arg)) {
      sawObject = true;
      const hasKey = arg.properties.some((p) => {
        if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
          const name = p.name.getText().replace(/['"]/g, "");
          return PAGINATION_KEYS.has(name);
        }
        return false;
      });
      if (hasKey) return "bounded";
    } else if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) || ts.isTemplateExpression(arg)) {
      sawScalarString = true;
      if (/limit/i.test(arg.getText())) return "bounded";
    } else {
      sawUnverifiable = true;
    }
  }

  // Object args with no pagination key -> confidently unbounded.
  if (sawObject) return "unbounded";
  // Only opaque variables/spreads -> can't tell, do not assert unbounded.
  if (sawUnverifiable) return "unknown";
  // Only string/SQL arguments without LIMIT -> unbounded.
  if (sawScalarString) return "unbounded";
  return "unbounded";
}
