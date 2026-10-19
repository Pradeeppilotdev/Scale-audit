import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";
import type { Finding } from "./types.js";
import { isDbWriteCall } from "./signals.js";

export interface CodemodEdit {
  /** Finding this edit came from. */
  findingId: string;
  file: string;
  line: number;
  /** Human-readable description of the change. */
  description: string;
  /** True when the patch is safe enough to apply without review. */
  safe: boolean;
}

export interface CodemodFilePlan {
  file: string;
  before: string;
  after: string;
  edits: CodemodEdit[];
}

export interface CodemodPlan {
  /** Per-file result of the plan. */
  files: CodemodFilePlan[];
  /** Number of findings that produced a patch. */
  patched: number;
  /** Number of findings we could not turn into a patch. */
  unpatched: number;
  /** Findings with no automated fix available. */
  manual: CodemodEdit[];
}

export interface CodemodResult {
  /** Combined unified diff, ready for `git apply`. */
  diff: string;
  patched: number;
  unpatched: number;
  manual: CodemodEdit[];
}

/** A change at an exact character offset in the source. */
interface PositionalEdit {
  /** Offset in the file where the text is inserted. */
  pos: number;
  text: string;
}

/**
 * Turn findings into concrete, reviewable source patches.
 *
 * This replaces the old "JEV validity percentage" experiment: instead of
 * reporting how many findings disappeared after a blind patch, we produce the
 * actual diff a developer can review and apply.
 *
 * Every patch is anchored to an exact AST offset rather than a regular
 * expression, so the result is syntactically valid code.
 */
export function planCodemod(root: string, findings: Finding[]): CodemodPlan {
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!PATCHABLE.has(f.id)) continue;
    const arr = byFile.get(f.file) ?? [];
    arr.push(f);
    byFile.set(f.file, arr);
  }

  const files: CodemodFilePlan[] = [];
  const manual: CodemodEdit[] = [];
  let patched = 0;
  let unpatched = 0;

  for (const [rel, fileFindings] of byFile) {
    const full = pathJoin(root, rel);
    let content: string;
    try {
      content = readFileSync(full, "utf8");
    } catch {
      unpatched += fileFindings.length;
      continue;
    }

    const sf = parse(rel, content);
    if (!sf) {
      unpatched += fileFindings.length;
      continue;
    }

    const edits: CodemodEdit[] = [];
    const positional: PositionalEdit[] = [];
    for (const f of fileFindings) {
      const edit = planEdit(sf, f);
      if (!edit) {
        unpatched++;
        manual.push({
          findingId: f.id,
          file: rel,
          line: f.line,
          description: "No safe automatic patch could be generated for this site; apply the suggested fix by hand.",
          safe: false,
        });
        continue;
      }
      patched++;
      positional.push(...edit.edits);
      edits.push({ findingId: f.id, file: rel, line: f.line, description: edit.description, safe: edit.safe });
    }

    if (edits.length === 0) continue;

    // Apply from the end of the file backwards so earlier offsets stay valid.
    const ordered = [...positional].sort((a, b) => b.pos - a.pos);
    let patchedContent = content;
    for (const e of ordered) {
      patchedContent = patchedContent.slice(0, e.pos) + e.text + patchedContent.slice(e.pos);
    }

    files.push({ file: rel, before: content, after: patchedContent, edits });
  }

  return { files, patched, unpatched, manual };
}

/** Render a plan as a combined unified diff. */
export function renderDiff(plan: CodemodPlan): string {
  return plan.files.map((f) => unifiedDiff(f.file, f.before, f.after)).filter(Boolean).join("");
}

/** Write the planned changes to disk. Returns the files that were changed. */
export function applyPlan(root: string, plan: CodemodPlan): string[] {
  const written: string[] = [];
  for (const f of plan.files) {
    const full = pathJoin(root, f.file);
    try {
      writeFileSync(full, f.after, "utf8");
      written.push(f.file);
    } catch {
      // leave the file untouched if it cannot be written
    }
  }
  return written;
}

const PATCHABLE = new Set([
  "unbounded-read",
  "unbounded-raw-query",
  "outbound-no-timeout",
  "floating-promise",
]);

interface Edit {
  description: string;
  safe: boolean;
  edits: PositionalEdit[];
}

function planEdit(sf: ts.SourceFile, f: Finding): Edit | null {
  switch (f.id) {
    case "unbounded-read":
      return planUnboundedRead(sf, f);
    case "unbounded-raw-query":
      return planRawQuery(sf, f);
    case "outbound-no-timeout":
      return planOutboundTimeout(sf, f);
    case "floating-promise":
      return planFloatingPromise(sf, f);
    default:
      return null;
  }
}

/** `findMany()` -> `findMany({ take: 50 })`; `findMany({ where })` -> `findMany({ take: 50, where })`. */
function planUnboundedRead(sf: ts.SourceFile, f: Finding): Edit | null {
  const call = findCallAtLine(sf, f.line, isCollectionRead);
  if (!call) return null;
  const method = (call.expression as ts.PropertyAccessExpression).name.getText();
  if (!/^(findMany|findAll)$/.test(method)) return null;
  const key = method === "findMany" ? "take" : "limit";

  if (call.arguments.length === 0) {
    // Insert the options object just before the closing paren.
    return {
      description: `add \`${key}: 50\` to ${method}()`,
      safe: true,
      edits: [{ pos: call.getEnd() - 1, text: `{ ${key}: 50 }` }],
    };
  }

  const arg = call.arguments[0];
  if (ts.isObjectLiteralExpression(arg)) {
    // Insert the key right after the opening brace.
    return {
      description: `add \`${key}: 50\` to ${method}()`,
      safe: true,
      edits: [{ pos: arg.getStart(sf) + 1, text: ` ${key}: 50,` }],
    };
  }
  return null;
}

/** Append a LIMIT to a raw SQL string or template. */
function planRawQuery(sf: ts.SourceFile, f: Finding): Edit | null {
  const call = findCallAtLine(sf, f.line, isRawQueryCall);
  if (!call) return null;
  const arg = call.arguments[0];
  if (!arg) return null;

  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    // Insert before the closing quote.
    return {
      description: "add `LIMIT 50` to the raw query",
      safe: true,
      edits: [{ pos: arg.getEnd() - 1, text: " LIMIT 50" }],
    };
  }
  if (ts.isTemplateExpression(arg)) {
    return {
      description: "add `LIMIT 50` to the raw query",
      safe: true,
      edits: [{ pos: arg.getEnd() - 1, text: " LIMIT 50" }],
    };
  }
  return null;
}

/** Add a timeout to an outbound call. */
function planOutboundTimeout(sf: ts.SourceFile, f: Finding): Edit | null {
  const call = findCallAtLine(sf, f.line, isOutboundCall);
  if (!call) return null;

  const expr = call.expression;
  const isFetch = ts.isIdentifier(expr) && expr.text === "fetch";
  const isAxios = ts.isPropertyAccessExpression(expr) && expr.expression.getText() === "axios";
  if (!isFetch && !isAxios) return null;

  if (isFetch) {
    if (call.arguments.length === 0) return null;
    if (call.arguments.length >= 2 && ts.isObjectLiteralExpression(call.arguments[1])) {
      // fetch(url, { ... }) -> fetch(url, { signal: ..., ... })
      const config = call.arguments[1];
      return {
        description: "add a 5s abort signal to the fetch call",
        safe: true,
        edits: [{ pos: config.getStart(sf) + 1, text: " signal: AbortSignal.timeout(5000)," }],
      };
    }
    // fetch(url) -> fetch(url, { signal: ... })
    const last = call.arguments[call.arguments.length - 1];
    return {
      description: "add a 5s abort signal to the fetch call",
      safe: true,
      edits: [{ pos: last.getEnd(), text: ", { signal: AbortSignal.timeout(5000) }" }],
    };
  }

  // axios: get(url, config) vs post(url, data, config)
  const method = (expr as ts.PropertyAccessExpression).name.getText();
  const hasBody = method === "post" || method === "put" || method === "patch";
  const configIndex = hasBody ? 2 : 1;
  const config = call.arguments[configIndex];

  if (config && ts.isObjectLiteralExpression(config)) {
    return {
      description: "add a 5s timeout to the axios call",
      safe: true,
      edits: [{ pos: config.getStart(sf) + 1, text: " timeout: 5000," }],
    };
  }
  if (config) return null; // config is a variable: we cannot extend it safely
  if (hasBody && call.arguments.length < 2) return null; // axios.post(url) would change meaning
  const lastArg = call.arguments[call.arguments.length - 1];
  return {
    description: "add a 5s timeout to the axios call",
    safe: true,
    edits: [{ pos: lastArg.getEnd(), text: ", { timeout: 5000 }" }],
  };
}

/** `db.user.create(x)` -> `await db.user.create(x)`. */
function planFloatingPromise(sf: ts.SourceFile, f: Finding): Edit | null {
  const call = findCallAtLine(sf, f.line, isWriteCall);
  if (!call) return null;
  return {
    description: "await the floating promise",
    safe: true,
    edits: [{ pos: call.getStart(sf), text: "await " }],
  };
}

// ---------------------------------------------------------------------------
// AST helpers

function findCallAtLine(sf: ts.SourceFile, line: number, predicate: (call: ts.CallExpression) => boolean): ts.CallExpression | null {
  let found: ts.CallExpression | null = null;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const ln = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      if (ln === line && predicate(node)) {
        found = node;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function isCollectionRead(call: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  const name = call.expression.name.getText();
  return name === "findMany" || name === "findAll";
}

function isRawQueryCall(call: ts.CallExpression): boolean {
  const name = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.getText() : "";
  return /^\$(query|execute)Raw/.test(name) || name === "raw";
}

function isOutboundCall(call: ts.CallExpression): boolean {
  const expr = call.expression;
  if (ts.isIdentifier(expr)) return expr.text === "fetch";
  if (ts.isPropertyAccessExpression(expr)) {
    const recv = expr.expression.getText();
    const method = expr.name.getText();
    return recv === "axios" && /^(get|post|put|delete|patch|head|options|request)$/.test(method);
  }
  return false;
}

function isWriteCall(call: ts.CallExpression): boolean {
  const name = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.getText() : "";
  if (!/^(create|update|delete|upsert|updateMany|deleteMany|createMany|insert|insertMany|save|remove|publish|send)$/.test(name)) {
    return false;
  }
  return isDbWriteCall(call);
}

// ---------------------------------------------------------------------------
// Text helpers

function parse(rel: string, content: string): ts.SourceFile | null {
  try {
    const kind = rel.endsWith(".tsx")
      ? ts.ScriptKind.TSX
      : rel.endsWith(".jsx")
        ? ts.ScriptKind.JSX
        : rel.endsWith(".js") || rel.endsWith(".mjs") || rel.endsWith(".cjs")
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
    return ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, true, kind);
  } catch {
    return null;
  }
}

function pathJoin(root: string, rel: string): string {
  return `${root.replace(/\/+$/, "")}/${rel}`;
}

/**
 * Unified diff with real hunk headers, so the output can be fed straight to
 * `git apply` or `patch -p1`.
 */
export function unifiedDiff(file: string, before: string, after: string): string {
  if (before === after) return "";
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const ops = diffLines(beforeLines, afterLines);
  const CONTEXT = 3;

  // A file that does not end with a newline needs the marker in the diff.
  const beforeNoNewline = before.length > 0 && !before.endsWith("\n");
  const afterNoNewline = after.length > 0 && !after.endsWith("\n");

  // Keep every line within CONTEXT of a change.
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].kind === " ") continue;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(ops.length - 1, i + CONTEXT); j++) keep[j] = true;
  }

  // Group contiguous kept lines into hunks.
  const hunks: Array<[number, number]> = [];
  let i = 0;
  while (i < ops.length) {
    if (!keep[i]) {
      i++;
      continue;
    }
    const start = i;
    while (i < ops.length && keep[i]) i++;
    hunks.push([start, i - 1]);
  }
  if (hunks.length === 0) return "";

  // Line number of each op in the old and the new file.
  const oldLineOf = new Array<number>(ops.length);
  const newLineOf = new Array<number>(ops.length);
  let oldLine = 1;
  let newLine = 1;
  for (let k = 0; k < ops.length; k++) {
    oldLineOf[k] = oldLine;
    newLineOf[k] = newLine;
    if (ops[k].kind !== "+") oldLine++;
    if (ops[k].kind !== "-") newLine++;
  }

  // Index of the final line of each side, for the "no newline" marker.
  let lastOld = -1;
  let lastNew = -1;
  for (let k = ops.length - 1; k >= 0; k--) {
    if (lastOld < 0 && ops[k].kind !== "+") lastOld = k;
    if (lastNew < 0 && ops[k].kind !== "-") lastNew = k;
  }

  const out: string[] = [`--- a/${file}`, `+++ b/${file}`];
  for (const [start, end] of hunks) {
    let oldCount = 0;
    let newCount = 0;
    for (let k = start; k <= end; k++) {
      if (ops[k].kind !== "+") oldCount++;
      if (ops[k].kind !== "-") newCount++;
    }
    out.push(`@@ -${oldLineOf[start]},${oldCount} +${newLineOf[start]},${newCount} @@`);
    for (let k = start; k <= end; k++) {
      const op = ops[k];
      if (op.kind === " ") out.push(` ${op.text}`);
      else if (op.kind === "-") out.push(`-${op.text}`);
      else out.push(`+${op.text}`);
      if (k === lastOld && beforeNoNewline) out.push("\\ No newline at end of file");
      if (k === lastNew && afterNoNewline) out.push("\\ No newline at end of file");
    }
  }
  return out.join("\n") + "\n";
}

/**
 * Split a file into lines.
 *
 * A trailing newline terminates the last line; it does not create an extra
 * empty line. Getting this wrong makes the diff contain a context line that
 * does not exist in the file, and `git apply` rejects the whole patch.
 */
function splitLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type DiffOp = { kind: " " | "-" | "+"; text: string };

function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // LCS table. Files here are small enough for O(n*m).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "-", text: a[i] });
      i++;
    } else {
      ops.push({ kind: "+", text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "-", text: a[i++] });
  while (j < m) ops.push({ kind: "+", text: b[j++] });
  return ops;
}
