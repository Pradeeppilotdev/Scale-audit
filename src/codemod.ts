import { axiosBodyMethod, axiosDefaultsAt, axiosInstance, axiosRequestInterceptorsObserved, checkerFor, currentImportedBinding, isAxiosMethod, isHttpFetch, moduleInputsKnown, projectFor } from "./bindings.js";
import { runtimeLoaderLookup } from "./moduleEffects.js";
import ts from "typescript";
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, opendirSync, openSync, readSync, realpathSync, writeSync } from "node:fs";
import path from "node:path";
import { readRepoFileSync, repoPathExists } from "./repoFiles.js";
import type { Finding } from "./types.js";
import { isDbWriteCall } from "./signals.js";
import { nativeAbortSignalUnchanged, nativeHttpGlobalsUnchanged } from "./nativeSignals.js";
import { AnalysisBudget, AnalysisLimitError } from "./analysisBudget.js";

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
  /** Number of findings that produced a suggestion (including review-required patches). */
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
 * Findings only identify a line: ambiguous candidates are left for manual
 * repair. Accepted patches use AST offsets and pass syntax validation.
 */
export function planCodemod(root: string, findings: Finding[], analyzedSources?: Iterable<ts.SourceFile>, httpContextComplete = true): CodemodPlan {
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
  // Other analyzed modules can replace a process-wide timeout factory too.
  const sources = analyzedSources ? [...analyzedSources] : undefined;
  const byName = sources && new Map(sources.map(source => [source.fileName, source]));
  const firstProject = sources?.[0] && projectFor(sources[0]);
  const project = firstProject && sources!.every(source => projectFor(source) === firstProject) ? firstProject : undefined;
  const proofSources = project ? [...project.sources.values()] : sources;
  const nativeSignal = proofSources?.every(nativeSignalAvailable);
  const nativeHttp = httpContextComplete ? proofSources?.every(nativeHttpAvailable) : false;

  for (const [rel, fileFindings] of byFile) {
    // UTF-16 is auditable, but patches require UTF-8 byte-for-byte validation.
    const content = readRepoFileSync(root, rel, undefined, false);
    const validated = content === null ? null : parse(rel, content);
    const analyzed = byName?.get(rel);
    // Planning needs the same module graph as the detector, plus a fresh
    // syntax and content check before using offsets from that graph.
    const sf = validated && (byName ? analyzed?.text === content ? analyzed : null : validated);
    if (content === null || !sf) {
      unpatched += fileFindings.length;
      for (const finding of fileFindings) manual.push(manualEdit(finding));
      continue;
    }

    const edits: CodemodEdit[] = [];
    const positional: PositionalEdit[] = [];
    const positions = new Set<number>();
    const calls = callsByLine(sf);
    // Every supplied source was covered above. A standalone plan checks its
    // freshly parsed file here instead of repeating a completed project proof.
    const canAddSignal = nativeSignal ?? nativeSignalAvailable(sf);
    const nativeMethods = nativeHttp ?? nativeHttpAvailable(sf);
    const sourceProject = projectFor(sf);
    const completeProject = !!sourceProject && !sourceProject.fileScoped && sourceProject === project;
    const hasTimeoutFinding = fileFindings.some(finding => finding.id === "outbound-no-timeout");
    const canEditHttp = nativeMethods && hasTimeoutFinding && localDependenciesAnalyzed(sf)
      && (completeProject || byFile.size === 1 && isolatedSource(root, rel));
    for (const f of fileFindings) {
      let edit: Edit | null;
      try { edit = planEdit(sf, f, calls, canAddSignal, canEditHttp); }
      catch (error) { if (!(error instanceof AnalysisLimitError)) throw error; edit = null; }
      if (!edit) {
        unpatched++;
        manual.push(manualEdit(f));
        continue;
      }
      // Do not duplicate an insertion for repeated findings, or compose
      // unrelated insertions at the same offset without knowing their order.
      if (edit.edits.some((e) => positions.has(e.pos))) {
        unpatched++;
        manual.push(manualEdit(f));
        continue;
      }
      for (const insertion of edit.edits) {
        positions.add(insertion.pos);
        positional.push(insertion);
      }
      edits.push({ findingId: f.id, file: rel, line: f.line, description: edit.description, safe: edit.safe });
    }

    if (edits.length === 0) continue;

    // Offsets refer to the original source. Assemble it once rather than
    // recopying the growing file for every generated insertion.
    const ordered = positional.sort((a, b) => a.pos - b.pos);
    const chunks: string[] = [];
    let cursor = 0;
    for (const e of ordered) {
      chunks.push(content.slice(cursor, e.pos), e.text);
      cursor = e.pos;
    }
    chunks.push(content.slice(cursor));
    const patchedContent = chunks.join("");

    if (!parse(rel, patchedContent)) {
      unpatched += edits.length;
      for (const edit of edits) manual.push({ ...edit, safe: false, description: "Generated patch failed syntax validation; fix this site by hand." });
      continue;
    }
    patched += edits.length;
    files.push({ file: rel, before: content, after: patchedContent, edits });
  }

  return { files, patched, unpatched, manual };
}

/** Render a plan as a combined unified diff. */
export function renderDiff(plan: CodemodPlan): string {
  return plan.files.map((f) => unifiedDiff(f.file, f.before, f.after)).filter(Boolean).join("");
}

/**
 * Write only wholly safe file plans. A review-required edit blocks the entire
 * file, including otherwise safe edits in that file. Counts in the plan are
 * suggestions; the returned paths are the authoritative list of applied files.
 */
export function applyPlan(root: string, plan: CodemodPlan): string[] {
  const written: string[] = [];
  for (const f of plan.files) {
    if (!f.edits.length || f.edits.some((e) => !e.safe) || !parse(f.file, f.after)) continue;
    let fd: number | undefined;
    try {
      // Recheck containment, symlink ancestors and bounded contents at apply time.
      if (readRepoFileSync(root, f.file) !== f.before || constants.O_NOFOLLOW === undefined) continue;
      const full = path.join(realpathSync(root), f.file);
      // Never use O_TRUNC: first inspect and read the actual write descriptor.
      fd = openSync(full, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size > MAX_FILE_BYTES) continue;
      const expected = Buffer.from(f.before, "utf8");
      if (before.size !== expected.length) continue;
      const actual = Buffer.alloc(expected.length + 1);
      let total = 0;
      while (total < actual.length) {
        const n = readSync(fd, actual, total, actual.length - total, total);
        if (n === 0) break;
        total += n;
      }
      if (total !== expected.length || !actual.subarray(0, total).equals(expected)) continue;
      if (readRepoFileSync(root, f.file) !== f.before) continue;
      const current = lstatSync(full);
      const checked = fstatSync(fd);
      if (!current.isFile() || current.dev !== checked.dev || current.ino !== checked.ino
        || before.size !== checked.size || before.mtimeMs !== checked.mtimeMs || before.ctimeMs !== checked.ctimeMs) continue;
      const output = Buffer.from(f.after, "utf8");
      let offset = 0;
      while (offset < output.length) {
        const n = writeSync(fd, output, offset, output.length - offset, offset);
        if (n === 0) throw new Error("Short codemod write");
        offset += n;
      }
      ftruncateSync(fd, output.length);
      written.push(f.file);
    } catch {
      // Unsafe, stale or inaccessible files are skipped. I/O errors after the
      // write starts can still leave a partial write; this is not a transaction.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return written;
}

const MAX_FILE_BYTES = 1_000_000;

function manualEdit(f: Finding): CodemodEdit {
  return {
    findingId: f.id, file: f.file, line: f.line,
    description: "No safe automatic patch could be generated for this site; apply the suggested fix by hand.",
    safe: false,
  };
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

function planEdit(sf: ts.SourceFile, f: Finding, calls: CallIndex, nativeSignal: boolean, nativeHttp: boolean): Edit | null {
  switch (f.id) {
    case "unbounded-read":
      return planUnboundedRead(sf, f, calls);
    // SQL dialect, statement boundaries and result semantics are unknown.
    case "unbounded-raw-query":
      return null;
    case "outbound-no-timeout":
      return nativeHttp ? planOutboundTimeout(sf, f, calls, nativeSignal) : null;
    case "floating-promise":
      return planFloatingPromise(sf, f, calls);
    default:
      return null;
  }
}

/** `findMany()` -> `findMany({ take: 50 })`; `findMany({ where })` -> `findMany({ take: 50, where })`. */
function planUnboundedRead(sf: ts.SourceFile, f: Finding, calls: CallIndex): Edit | null {
  const call = findCallAtLine(calls, f.line, isCollectionRead);
  if (!call) return null;
  const method = (call.expression as ts.PropertyAccessExpression).name.getText();
  if (!/^(findMany|findAll)$/.test(method)) return null;
  const key = method === "findMany" ? "take" : "limit";

  if (call.arguments.some(ts.isSpreadElement) || call.arguments.length > 1) return null;
  if (call.arguments.length === 0) {
    // Insert the options object just before the closing paren.
    return {
      description: `add \`${key}: 50\` to ${method}()`,
      safe: false,
      edits: [{ pos: call.getEnd() - 1, text: `{ ${key}: 50 }` }],
    };
  }

  const arg = call.arguments[0];
  if (ts.isObjectLiteralExpression(arg) && extensibleConfig(arg, ["take", "limit", "skip", "offset", "cursor"])) {
    // Insert the key right after the opening brace.
    return {
      description: `add \`${key}: 50\` to ${method}()`,
      safe: false,
      edits: [{ pos: arg.getStart(sf) + 1, text: ` ${key}: 50,` }],
    };
  }
  return null;
}


/** Add a timeout to an outbound call. */
function planOutboundTimeout(sf: ts.SourceFile, f: Finding, calls: CallIndex, nativeSignal: boolean): Edit | null {
  const call = findCallAtLine(calls, f.line, isOutboundCall);
  if (!call || call.arguments.some(ts.isSpreadElement) || call.questionDotToken) return null;

  const expr = call.expression;
  const isFetch = isHttpFetch(expr);
  const isAxios = (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) && isAxiosMethod(expr);
  if (!isFetch && !isAxios) return null;

  if (isFetch) {
    // Generated code must not accidentally call a user-defined AbortSignal.
    if (!nativeSignal || checkerFor(sf).resolveName("AbortSignal", call, ts.SymbolFlags.Value, false)) return null;
    if (call.arguments.length === 0 || call.arguments.length > 2) return null;
    // A Request input can carry its own cancellation signal. Only inputs
    // known to produce strings can safely receive a new signal without
    // inspecting (or evaluating again) the first argument.
    const input = call.arguments[0];
    if (!ts.isStringLiteral(input) && !ts.isNoSubstitutionTemplateLiteral(input) && !ts.isTemplateExpression(input)) return null;
    if (call.arguments.length === 2) {
      if (!ts.isObjectLiteralExpression(call.arguments[1]) || !extensibleConfig(call.arguments[1], ["signal", "timeout"])) return null;
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
  const binding = currentImportedBinding(expr);
  if (!binding || axiosInstance(binding) || axiosDefaultsAt(binding, call).changed || axiosRequestInterceptorsObserved(binding, call)) return null;
  const method = binding.name, hasBody = axiosBodyMethod(method);
  const configIndex = method === "request" ? 0 : hasBody ? 2 : 1;
  if (call.arguments.length === 0 || call.arguments.length > configIndex + 1) return null;
  const config = call.arguments[configIndex];

  if (config && ts.isObjectLiteralExpression(config)) {
    if (!extensibleConfig(config, ["signal", "timeout", "cancelToken"])) return null;
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

/** A single-file detector finding can already be ineligible for edits, e.g.
 * an opaque config, an existing signal or an unsupported http.request. */
export function hasHttpEditCandidate(sf: ts.SourceFile, findings: readonly Finding[]): boolean {
  const local = findings.filter(f => f.id === "outbound-no-timeout" && f.file === sf.fileName);
  if (!local.length || !nativeHttpAvailable(sf)) return false;
  const calls = callsByLine(sf), signal = nativeSignalAvailable(sf);
  try { return local.some(f => !!planOutboundTimeout(sf, f, calls, signal)); }
  catch (error) { if (error instanceof AnalysisLimitError) return false; throw error; }
}

/** `db.user.create(x)` -> `await db.user.create(x)`. */
function planFloatingPromise(sf: ts.SourceFile, f: Finding, calls: CallIndex): Edit | null {
  const call = findCallAtLine(calls, f.line, isWriteCall);
  if (!call || !ts.isExpressionStatement(call.parent) || call.parent.expression !== call) return null;
  // Await belongs to the nearest function, not an outer async callback.
  let owner: ts.Node | undefined = call.parent;
  while (owner && !ts.isFunctionLike(owner)) {
    if (ts.isClassStaticBlockDeclaration(owner)) return null;
    owner = owner.parent;
  }
  if (!owner || !ts.canHaveModifiers(owner) || !ts.getModifiers(owner)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return null;
  return {
    description: "await the floating promise (review ordering and error propagation)",
    safe: false,
    edits: [{ pos: call.getStart(sf), text: "await " }],
  };
}

// ---------------------------------------------------------------------------
// AST helpers

type CallIndex = ReadonlyMap<number, ts.CallExpression | null>;

function callsByLine(sf: ts.SourceFile): CallIndex {
  const calls = new Map<number, ts.CallExpression | null>();
  const pending: ts.Node[] = [sf];
  while (pending.length) {
    const node = pending.pop()!;
    if (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      calls.set(line, ts.isCallExpression(node) && !calls.has(line) ? node : null);
    }
    ts.forEachChild(node, child => { pending.push(child); });
  }
  return calls;
}

function findCallAtLine(calls: CallIndex, line: number, predicate: (call: ts.CallExpression) => boolean): ts.CallExpression | null {
  // A tagged SQL template or another call on the same line can own the finding.
  // Only one unambiguous call can receive a generated edit.
  const call = calls.get(line);
  return call && predicate(call) ? call : null;
}

function isCollectionRead(call: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  const name = call.expression.name.getText();
  return name === "findMany" || name === "findAll";
}


function isOutboundCall(call: ts.CallExpression): boolean {
  const expr = call.expression;
  return isHttpFetch(expr) || (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) && isAxiosMethod(expr);
}

function localDependenciesAnalyzed(sf: ts.SourceFile): boolean {
  try {
    return projectFor(sf) ? moduleInputsKnown(sf) : standaloneInputsKnown(sf);
  } catch (error) { if (error instanceof AnalysisLimitError) return false; throw error; }
}
function standaloneInputsKnown(sf: ts.SourceFile): boolean {
  const budget = new AnalysisBudget("Standalone HTTP context");
  const loader = runtimeLoaderLookup(budget);
  const pending: ts.Node[] = [sf];
  while (pending.length) {
    budget.take();
    const node = pending.pop()!;
    const runtimeLoad = ts.isCallExpression(node) && node.arguments.length > 0
      ? node.expression.kind === ts.SyntaxKind.ImportKeyword ? "here" : loader(node.expression) : undefined;
    if (runtimeLoad === "unknown") return false;
    const specifier = (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly || ts.isExportDeclaration(node) && !node.isTypeOnly)
      ? node.moduleSpecifier : ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)
        ? node.moduleReference.expression : ts.isCallExpression(node) && runtimeLoad ? node.arguments[0] : undefined;
    if (specifier && (!ts.isStringLiteralLike(specifier) || /^(?:[.#/]|file:)/.test(specifier.text))) return false;
    ts.forEachChild(node, child => { pending.push(child); });
  }
  return true;
}

/** Without analyzed project sources, prove a single-source tree or leave the
 * edit manual. Inspect only the target's ancestor directories. Another branch
 * could contain an entry that reconfigures this client's defaults or methods. */
function isolatedSource(root: string, rel: string): boolean {
  const parts = rel.split("/"), budget = new AnalysisBudget("Standalone HTTP context");
  let directory = "";
  try {
    for (const part of parts) {
      budget.take();
      if (directory && !repoPathExists(root, directory, true)) return false;
      const handle = opendirSync(path.join(root, directory));
      try {
        for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
          budget.take();
          if (entry.name === part || entry.name === ".git" || entry.name === "node_modules") continue;
          if (entry.isDirectory() || entry.isSymbolicLink() || /\.[cm]?[jt]sx?$/i.test(entry.name)) return false;
        }
      } finally { handle.closeSync(); }
      directory = path.posix.join(directory, part);
    }
    return true;
  } catch { return false; }
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
    const sf = ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, true, kind);
    // TypeScript's parser recovers from syntax errors rather than throwing.
    const diagnostics = (sf as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
    if (diagnostics.length) return null;
    const result = ts.transpileModule(content, {
      fileName: rel,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve },
    });
    return result.diagnostics?.some((d) => d.category === ts.DiagnosticCategory.Error) ? null : sf;
  } catch {
    return null;
  }
}

/** Unknown keys (including spreads/computed names) may hide an existing option. */
function extensibleConfig(config: ts.ObjectLiteralExpression, reserved: string[]): boolean {
  return config.properties.every((p) => {
    if (ts.isSpreadAssignment(p) || !p.name || ts.isComputedPropertyName(p.name)) return false;
    const name = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name) ? p.name.text : null;
    // The special literal key can install inherited cancellation/options.
    return name !== null && name !== "__proto__" && !reserved.includes(name);
  });
}

/** Exhausted proof leaves a patch manual. The detector retains its failure in
 * the report; requesting a diff must not discard an incomplete audit. */
function nativeSignalAvailable(sf: ts.SourceFile): boolean {
  try { return nativeAbortSignalUnchanged(sf); }
  catch (error) { if (error instanceof AnalysisLimitError) return false; throw error; }
}

function nativeHttpAvailable(sf: ts.SourceFile): boolean {
  try { return nativeHttpGlobalsUnchanged(sf); }
  catch (error) { if (error instanceof AnalysisLimitError) return false; throw error; }
}

/**
 * Unified diff with real hunk headers, so the output can be fed straight to
 * `git apply` or `patch -p1`.
 */
export function unifiedDiff(file: string, before: string, after: string): string {
  if (before === after) return "";
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  // A newline-only change must replace the final line, not become context.
  const newlineChanged = before.endsWith("\n") !== after.endsWith("\n");
  const ops = diffLines(beforeLines, afterLines, newlineChanged);
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

  const quotePath = (prefix: string) => /[\s"\\]/.test(file) ? JSON.stringify(`${prefix}/${file}`) : `${prefix}/${file}`;
  const out: string[] = [`--- ${quotePath("a")}`, `+++ ${quotePath("b")}`];
  for (const [start, end] of hunks) {
    let oldCount = 0;
    let newCount = 0;
    for (let k = start; k <= end; k++) {
      if (ops[k].kind !== "+") oldCount++;
      if (ops[k].kind !== "-") newCount++;
    }
    out.push(`@@ -${oldLineOf[start] - (oldCount === 0 ? 1 : 0)},${oldCount} +${newLineOf[start] - (newCount === 0 ? 1 : 0)},${newCount} @@`);
    for (let k = start; k <= end; k++) {
      const op = ops[k];
      if (op.kind === " ") out.push(` ${op.text}`);
      else if (op.kind === "-") out.push(`-${op.text}`);
      else out.push(`+${op.text}`);
      if ((k === lastOld && beforeNoNewline) || (k === lastNew && afterNoNewline)) out.push("\\ No newline at end of file");
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

function diffLines(a: string[], b: string[], newlineChanged = false): DiffOp[] {
  // Trim shared edges first. Bound both LCS time and memory; for a large
  // changed region use a coarser (but valid) delete/insert hunk instead.
  let prefix = 0;
  const shared = Math.min(a.length, b.length);
  while (prefix < shared && a[prefix] === b[prefix]
    && !(newlineChanged && (prefix === a.length - 1 || prefix === b.length - 1))) prefix++;
  let suffix = 0;
  if (!newlineChanged) {
    while (suffix < shared - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
  }
  const leading: DiffOp[] = a.slice(0, prefix).map((text) => ({ kind: " ", text }));
  const trailing: DiffOp[] = suffix ? a.slice(a.length - suffix).map((text) => ({ kind: " ", text })) : [];
  a = a.slice(prefix, a.length - suffix);
  b = b.slice(prefix, b.length - suffix);
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > 250_000 || newlineChanged) {
    return [...leading, ...a.map((text): DiffOp => ({ kind: "-", text })),
      ...b.map((text): DiffOp => ({ kind: "+", text })), ...trailing];
  }
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
  return [...leading, ...ops, ...trailing];
}
