import { importedBinding, symbolOf } from "../bindings.js";
import ts from "typescript";
import { lineOf, snippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";
import { Workspace } from "../workspace.js";

const ALL_METHODS = new Set(["all", "allSettled"]);

/**
 * Property names that usually hold a user-sized collection.
 * `rows`, `items`, `users` etc. are the classic shapes.
 */
const COLLECTION_PROPERTIES = new Set([
  "items",
  "rows",
  "records",
  "results",
  "entries",
  "elements",
  "list",
  "users",
  "posts",
  "orders",
  "products",
  "customers",
  "messages",
  "events",
  "jobs",
  "tasks",
  "files",
  "children",
  "data",
]);

export async function detectUnboundedConcurrency(root: string, ws?: Workspace): Promise<Finding[]> {
  const out: Finding[] = [];
  const workspace = ws ?? (await Workspace.load(root));
  for (const { rel, content, sf } of workspace.units) {
    visit(sf, sf, content, rel, out);
  }
  return out;
}

function visit(node: ts.Node, sf: ts.SourceFile, content: string, rel: string, out: Finding[]): void {
  if (ts.isCallExpression(node) && isPromiseAll(node)) {
    const arg = node.arguments[0];
    if (arg && ts.isCallExpression(arg) && ts.isPropertyAccessExpression(arg.expression)) {
      const method = arg.expression.name.getText();
      const receiver = arg.expression.expression;
      // Fixed-size literals / ALL_CAPS constants are not user-sized collections.
      const fixedSize =
        ts.isArrayLiteralExpression(receiver) ||
        (ts.isIdentifier(receiver) && /^[A-Z][A-Z0-9_]{1,}$/.test(receiver.text));
      if ((method === "map" || method === "flatMap") && !isLimited(arg) && !fixedSize && isUserSized(receiver, arg)) {
        const ln = lineOf(sf, node);
        out.push(
          makeFinding({
            id: "unbounded-concurrency",
            category: "Concurrency",
            severity: "medium",
            confidence: "medium",
            file: rel,
            line: ln,
            message: `Promise.${calleeName(node)} runs one task per item with no concurrency cap.`,
            scaleTrigger: "Large collections fire unbounded parallel work, spiking memory/DB connections and starving the event loop.",
            suggestedFix: "Batch the work (chunking) or cap concurrency with p-limit/Array.from chunks (e.g. 10-50 in flight).",
            snippet: snippetAt(content, ln),
          }),
        );
      }
    }
  }
  ts.forEachChild(node, (c) => visit(c, sf, content, rel, out));
}

function isPromiseAll(node: ts.CallExpression): boolean {
  const expr = node.expression;
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "Promise" &&
    ALL_METHODS.has(expr.name.getText())
  );
}

function calleeName(node: ts.CallExpression): string {
  return ts.isPropertyAccessExpression(node.expression) ? node.expression.name.getText() : "all";
}

/** Heuristic: already wrapped in a limiter/chunk helper. */
function isLimited(call: ts.CallExpression): boolean {
  const callback = call.arguments[0];
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return false;
  let returned: ts.Expression | undefined;
  if (ts.isBlock(callback.body)) {
    if (callback.body.statements.length !== 1 || !ts.isReturnStatement(callback.body.statements[0])) return false;
    returned = callback.body.statements[0].expression;
  } else returned = callback.body;
  if (returned && ts.isAwaitExpression(returned)) returned = returned.expression;
  if (!returned || !ts.isCallExpression(returned) || !ts.isIdentifier(returned.expression)) return false;
  const declaration = symbolOf(returned.expression)?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer || !ts.isCallExpression(declaration.initializer)) return false;
  const factory = declaration.initializer;
  return importedBinding(factory.expression)?.module === "p-limit" && !!factory.arguments[0]
    && ts.isNumericLiteral(factory.arguments[0]) && Number(factory.arguments[0].text) > 0;
}

/**
 * Is the mapped collection plausibly user-sized?
 *
 * `Promise.all(xs.map(...))` is only a scaling problem when `xs` can grow.
 * A local array of render callbacks is not. We require positive evidence:
 * the collection comes from a database read, it is a function parameter, or it
 * is a property with a collection-ish name.
 *
 * Scopes are respected: only *enclosing* parameters and declarations count, so
 * an unrelated `callbacks` parameter elsewhere in the file does not count.
 */
function isUserSized(receiver: ts.Expression, node: ts.Node, seen = new Set<ts.Node>()): boolean {
  if (seen.has(receiver) || seen.size > 128) return false;
  seen.add(receiver);
  if (ts.isAwaitExpression(receiver) || ts.isParenthesizedExpression(receiver)) return isUserSized(receiver.expression, node, seen);
  // `await db.findMany()` / `db.findAll()`
  if (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)) {
    const method = receiver.expression.name.getText();
    if (method === "findMany" || method === "findAll" || method === "find") return true;
  }
  // `res.rows`, `page.items`
  if (ts.isPropertyAccessExpression(receiver)) {
    const name = receiver.name.getText();
    if (COLLECTION_PROPERTIES.has(name)) return true;
    // `res.data.items`
    if (ts.isPropertyAccessExpression(receiver.expression)) {
      const outer = receiver.expression.name.getText();
      if (COLLECTION_PROPERTIES.has(outer)) return true;
    }
  }
  // A function parameter: the size is controlled by the caller.
  if (ts.isIdentifier(receiver) && symbolOf(receiver)?.declarations?.some(ts.isParameter)) return true;
  // A local bound directly from one of the above.
  if (ts.isIdentifier(receiver)) {
    const declaration = symbolOf(receiver)?.valueDeclaration;
    const init = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
    if (init) {
      // `const queue: string[] = []` starts empty and is filled at runtime, so
      // its size is unbounded. A non-empty literal is a fixed-size constant.
      if (ts.isArrayLiteralExpression(init) && init.elements.length === 0) return true;
      return isUserSized(init, node, seen);
    }
  }
  return false;
}
