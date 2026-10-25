import { projectFor, symbolOf } from "./bindings.js";
import path from "node:path";
import ts from "typescript";
import type { Workspace } from "./workspace.js";
import { isRecord, parseRepoManifest, readRepoFile } from "./repoFiles.js";

export interface ExecutionContext {
  request: boolean;
  cli: boolean;
  worker: boolean;
}

/** Conservative module reachability, not a whole-program call graph. Runtime
 * imports inherit their caller's context; type-only imports do not execute.
 * A module reachable from a request entry always takes precedence over isolation.
 */
export async function executionContexts(root: string, workspace: Workspace, requestPath: (rel: string) => boolean): Promise<Map<string, ExecutionContext>> {
  const units = new Map(workspace.units.map(unit => [unit.rel, unit]));
  const graph = new Map<string, Set<string>>();
  const roots = { request: new Set<string>(), cli: new Set<string>(), worker: new Set<string>() };
  const project = workspace.units[0] && projectFor(workspace.units[0].sf);
  const resolve = (from: string, spec: string): string | undefined => project?.resolve(from, spec);
  const pkg = parseRepoManifest(await readRepoFile(root, "package.json"));
  const configText = await readRepoFile(root, "tsconfig.json");
  const config: unknown = configText === null ? {} : ts.parseConfigFileTextToJson("tsconfig.json", configText).config;
  const compiler = isRecord(config) && isRecord(config.compilerOptions) ? config.compilerOptions : {};
  const bins = typeof pkg.bin === "string" ? [pkg.bin] : isRecord(pkg.bin) ? Object.values(pkg.bin).filter((v): v is string => typeof v === "string") : [];
  for (const bin of bins) {
    let source = bin;
    if (typeof compiler.outDir === "string" && typeof compiler.rootDir === "string") {
      const out = path.posix.normalize(compiler.outDir).replace(/\/$/, "") + "/";
      const normalized = path.posix.normalize(bin);
      if (normalized.startsWith(out)) source = path.posix.join(compiler.rootDir, normalized.slice(out.length));
    }
    const entry = resolve("package.json", "./" + source);
    if (entry) roots.cli.add(entry);
  }
  for (const { rel, sf, content } of workspace.units) {
    const edges = new Set<string>();
    graph.set(rel, edges);
    if (/^#![^\n]*\bnode\b/.test(content)) roots.cli.add(rel);
    if (requestPath(rel)) roots.request.add(rel);
    const add = (spec: string) => { const target = resolve(rel, spec); if (target) edges.add(target); };
    const childBindings = new Map<string, string>();
    const workerBindings = new Set<string>();
    const httpFactories = new Set<string>();
    for (const statement of sf.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const clause = statement.importClause;
        if (clause?.isTypeOnly) continue;
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
          && !clause.name && clause.namedBindings.elements.length && clause.namedBindings.elements.every(e => e.isTypeOnly)) continue;
        add(statement.moduleSpecifier.text);
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const binding of clause.namedBindings.elements) {
            if (binding.isTypeOnly) continue;
            const name = (binding.propertyName ?? binding.name).text;
            if (/^(node:)?https?$/.test(statement.moduleSpecifier.text) && name === "createServer") httpFactories.add(binding.name.text);
            if (/^(node:)?child_process$/.test(statement.moduleSpecifier.text)) childBindings.set(binding.name.text, name);
            if (/^(node:)?worker_threads$/.test(statement.moduleSpecifier.text) && name === "Worker") workerBindings.add(binding.name.text);
          }
        }
      }
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const bindings = statement.exportClause;
        if (!bindings || !ts.isNamedExports(bindings) || !bindings.elements.length || !bindings.elements.every(e => e.isTypeOnly)) add(statement.moduleSpecifier.text);
      }
    }
    const visit = (node: ts.Node) => {
      if (ts.isFunctionLike(node) && node.parameters.length >= 2
        && /^(req|request)$/.test(node.parameters[0].name.getText())
        && /^(res|response|reply)$/.test(node.parameters[1].name.getText())) roots.request.add(rel);
      if (ts.isCallExpression(node)) {
        if ((node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
          && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) add(node.arguments[0].text);
        // Route/server registrations override script-directory and CLI hints.
        const callee = node.expression.getText();
        const receiver = ts.isPropertyAccessExpression(node.expression) ? node.expression.expression : undefined;
        const declaration = receiver ? symbolOf(receiver)?.valueDeclaration : undefined;
        const localCollection = declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
          && ts.isNewExpression(declaration.initializer) && /^(Map|Set|WeakMap|WeakSet)$/.test(declaration.initializer.expression.getText());
        if ((!localCollection && /^(app|router|server)\.(get|post|put|patch|delete|use|all|route|listen)$/.test(callee))
          || (ts.isIdentifier(node.expression) && httpFactories.has(callee))
          || /^(http|https)\.createServer$/.test(callee)) roots.request.add(rel);
      }
      const args = ts.isCallExpression(node) || ts.isNewExpression(node) ? node.arguments : undefined;
      const expr = ts.isCallExpression(node) || ts.isNewExpression(node) ? node.expression : undefined;
      const method = expr && ts.isIdentifier(expr) ? childBindings.get(expr.text) : undefined;
      const isNodeLaunch = method === "fork" || ((method === "spawn" || method === "execFile") && args?.[0]
        && (args[0].getText() === "process.execPath" || (ts.isStringLiteral(args[0]) && args[0].text === "node")));
      const isWorker = expr && ts.isIdentifier(expr) && workerBindings.has(expr.text);
      if (args && (isNodeLaunch || isWorker)) {
        const findUrl = (part: ts.Node) => {
          if (ts.isNewExpression(part) && part.expression.getText() === "URL" && part.arguments?.[0] && ts.isStringLiteral(part.arguments[0])
            && part.arguments[1]?.getText() === "import.meta.url") {
            const target = resolve(rel, part.arguments[0].text);
            if (target) roots.worker.add(target);
          }
          ts.forEachChild(part, findUrl);
        };
        for (const arg of args) findUrl(arg);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  const result = new Map<string, ExecutionContext>();
  for (const kind of ["request", "cli", "worker"] as const) {
    const pending = [...roots[kind]], seen = new Set<string>();
    while (pending.length) {
      const rel = pending.pop()!;
      if (seen.has(rel)) continue;
      seen.add(rel);
      const context = result.get(rel) ?? { request: false, cli: false, worker: false };
      context[kind] = true;
      result.set(rel, context);
      pending.push(...(graph.get(rel) ?? []));
    }
  }
  return result;
}
