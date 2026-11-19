import path from "node:path";
import ts from "typescript";
import { AnalysisBudget, projectWorkLimit } from "./analysisBudget.js";
import { readRepoFile, RepoInputBudget, MAX_MANIFEST_BYTES, isRecord, parseRepoManifest } from "./repoFiles.js";

interface Config { base: string; paths: Record<string, string[]>; raw: Record<string, unknown> }
interface PathPattern { prefix: string; suffix: string; targets: string[] }
interface PathMatch { targets: string[]; replacement: string }
interface CompiledPaths { patterns: PathPattern[]; matches: Map<string, PathMatch | undefined> }
interface ResolvedFile { file: string; compilerOnly: boolean }
interface PackageScope { directory: string; esm: boolean; name?: string; exports?: unknown; imports?: Record<string, unknown> }
/** In-repository resolution only: no target code, package hooks or external config is loaded. */
export class SourceProject {
  readonly sources: Map<string, ts.SourceFile>;
  private configs = new Map<string, Config>();
  private byFile = new Map<string, Config>();
  private readonly resolutions = new Map<string, Map<string, ResolvedFile | undefined>>();
  private readonly compiledPaths = new WeakMap<Config["paths"], CompiledPaths>();
  private resolutionWork?: AnalysisBudget;
  private budget = new RepoInputBudget("TypeScript config", MAX_MANIFEST_BYTES);
  private packageBudget = new RepoInputBudget("parser package metadata", MAX_MANIFEST_BYTES);
  private packages = new Map<string, PackageScope | null>();
  private constructor(private root: string, sources: { rel: string; sf?: ts.SourceFile }[], readonly fileScoped: boolean) {
    this.sources = new Map(sources.flatMap(unit => unit.sf ? [[unit.rel, unit.sf] as const] : []));
  }
  registerSources(units: { rel: string; sf: ts.SourceFile }[]): void {
    let changed = false;
    for (const { rel, sf } of units) {
      if (this.sources.get(rel) === sf) continue;
      this.sources.set(rel, sf);
      changed = true;
    }
    if (changed) { this.resolutions.clear(); this.resolutionWork = undefined; }
  }
  static async create(root: string, sources: { rel: string; sf?: ts.SourceFile }[], fileScoped = false): Promise<SourceProject> {
    const project = new SourceProject(root, sources, fileScoped);
    const directories = new Map<string, Config>();
    for (const { rel, sf } of sources) {
      const directory = path.posix.dirname(rel);
      let config = directories.get(directory);
      if (!config) {
        let current = directory;
        while (true) {
          const candidate = current === "." ? "tsconfig.json" : `${current}/tsconfig.json`;
          const found = await project.loadConfig(candidate, new Set());
          if (found) { config = found; break; }
          if (current === ".") break;
          current = path.posix.dirname(current);
        }
        config ??= { base: ".", paths: {}, raw: {} };
        directories.set(directory, config);
      }
      project.byFile.set(rel, config);
      if (sf) await project.packageScope(rel);
    }
    return project;
  }
  private missing = new Set<string>();
  private async loadConfig(rel: string, seen: Set<string>): Promise<Config | undefined> {
    if (rel.startsWith("../") || path.posix.isAbsolute(rel) || seen.has(rel) || seen.size > 32) return undefined;
    if (this.configs.has(rel)) return this.configs.get(rel);
    if (this.missing.has(rel)) return undefined;
    const content = await readRepoFile(this.root, rel);
    if (content === null) { this.missing.add(rel); return undefined; }
    this.budget.add(content);
    if (this.configs.size > 2000) throw new Error("Repository TypeScript config count exceeds limit of 2000");
    const parsed = ts.parseConfigFileTextToJson(rel, content);
    const json: unknown = parsed.config;
    if (parsed.error || !isRecord(json)) { this.missing.add(rel); return undefined; }
    const next = new Set(seen).add(rel);
    let inherited: Config | undefined;
    if (typeof json.extends === "string" && json.extends.startsWith(".")) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(rel), json.extends));
      inherited = await this.loadConfig(base.endsWith(".json") ? base : base + ".json", next);
    }
    const options = isRecord(json.compilerOptions) ? json.compilerOptions : {};
    const directory = path.posix.dirname(rel);
    // In the absence of a baseUrl, paths are relative to the config that
    // declares them, including a child config replacing inherited paths.
    const base = typeof options.baseUrl === "string" ? path.posix.normalize(path.posix.join(directory, options.baseUrl))
      : isRecord(options.paths) && typeof inherited?.raw.baseUrl !== "string" ? directory : inherited?.base ?? directory;
    const paths: Record<string, string[]> = Object.create(null);
    if (isRecord(options.paths)) for (const [key, value] of Object.entries(options.paths)) {
      if (Array.isArray(value)) paths[key] = value.filter((item): item is string => typeof item === "string");
    }
    const config = { base, paths: isRecord(options.paths) ? paths : inherited?.paths ?? {}, raw: { ...inherited?.raw, ...options } };
    this.configs.set(rel, config);
    return config;
  }
  compilerOptions(from: string): Record<string, unknown> { return this.byFile.get(from)?.raw ?? {}; }
  async packageScope(from: string): Promise<PackageScope | null> {
    let directory = path.posix.dirname(from);
    const visited: string[] = [];
    while (!this.packages.has(directory)) {
      visited.push(directory);
      const text = await readRepoFile(this.root, path.posix.join(directory, "package.json"));
      if (text !== null) {
        this.packageBudget.add(text);
        const manifest = parseRepoManifest(text);
        this.packages.set(directory, { directory, esm: manifest?.type === "module",
          name: typeof manifest.name === "string" ? manifest.name : undefined, exports: manifest.exports,
          imports: isRecord(manifest?.imports) ? manifest.imports : undefined });
        break;
      }
      if (directory === ".") break;
      directory = path.posix.dirname(directory);
    }
    const scope = this.packages.get(directory) ?? null;
    for (const dir of visited) this.packages.set(dir, scope);
    if (visited.length) this.resolutions.clear();
    return scope;
  }
  isPackageSelfReference(from: string, specifier: string): boolean {
    const scope = this.packages.get(path.posix.dirname(from));
    return !!scope?.name && scope.exports !== undefined
      && (specifier === scope.name || specifier.startsWith(scope.name + "/"));
  }
  compilerOnlyResolution(from: string, specifier: string): boolean {
    // A compiler path alias can select a local shim while ordinary Node package
    // resolution loads a different client. It can inform reports, but cannot
    // establish the runtime method and argument layout for an automatic edit.
    return this.resolutions.get(from)?.get(specifier)?.compilerOnly ?? false;
  }
  runtimeTargetAmbiguous(specifier: string, resolved: string): boolean {
    // A TS caller can be run directly or emitted. Two eligible implementations
    // of its explicit JS import cannot establish a single startup mutation.
    const extension = path.posix.extname(specifier), sourceExtension = path.posix.extname(resolved);
    if (/^\.[cm]?tsx?$/.test(extension) || !/^\.[cm]?tsx?$/.test(sourceExtension)) return false;
    const base = resolved.slice(0, -sourceExtension.length);
    const runtime = sourceExtension === ".mts" ? [".mjs"] : sourceExtension === ".cts" ? [".cjs"] : [".js", ".jsx"];
    return runtime.some(ext => this.sources.has(base + ext));
  }
  resolve(from: string, specifier: string): string | undefined {
    const budget = this.resolutionWork ??= new AnalysisBudget("Module resolution", projectWorkLimit(this.sources.values()));
    budget.take();
    const reads = this.resolutions.get(from);
    if (reads?.has(specifier)) return reads.get(specifier)?.file;
    const result = this.resolveUncached(from, specifier, budget);
    if (reads) reads.set(specifier, result);
    else this.resolutions.set(from, new Map([[specifier, result]]));
    return result?.file;
  }
  private pathMatch(paths: Config["paths"], specifier: string, budget: AnalysisBudget): PathMatch | undefined {
    if (!specifier.includes("*") && Object.hasOwn(paths, specifier)) return { targets: paths[specifier], replacement: "" };
    let compiled = this.compiledPaths.get(paths);
    if (!compiled) {
      const patterns: PathPattern[] = [];
      for (const key of Object.keys(paths)) {
        budget.take();
        const star = key.indexOf("*");
        if (star >= 0 && !key.includes("*", star + 1)) patterns.push({ prefix: key.slice(0, star), suffix: key.slice(star + 1), targets: paths[key] });
      }
      // TypeScript chooses the longest matching prefix and preserves declaration order on ties.
      patterns.sort((a, b) => { budget.take(); return b.prefix.length - a.prefix.length; });
      compiled = { patterns, matches: new Map() };
      this.compiledPaths.set(paths, compiled);
    }
    if (compiled.matches.has(specifier)) return compiled.matches.get(specifier);
    let match: PathMatch | undefined;
    for (const { prefix, suffix, targets } of compiled.patterns) {
      budget.take();
      if (specifier.length < prefix.length + suffix.length || !specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
      match = { targets, replacement: specifier.slice(prefix.length, specifier.length - suffix.length) };
      break;
    }
    compiled.matches.set(specifier, match);
    return match;
  }
  private resolveUncached(from: string, specifier: string, budget: AnalysisBudget): ResolvedFile | undefined {
    const candidates: string[] = [];
    let firstCompilerTarget = Infinity;
    if (specifier.startsWith(".")) candidates.push(path.posix.join(path.posix.dirname(from), specifier));
    else {
      const config = this.byFile.get(from);
      if (!config) return undefined;
      if (this.isPackageSelfReference(from, specifier)) {
        const scope = this.packages.get(path.posix.dirname(from))!;
        const key = "." + specifier.slice(scope.name!.length);
        const target = typeof scope.exports === "string" && key === "." ? scope.exports
          : isRecord(scope.exports) ? scope.exports[key] : undefined;
        // A conditional or patterned self-export has no single proven target.
        if (typeof target !== "string" || !target.startsWith("./")
          || target.slice(2).split("/").some(part => !part || [".", "..", "node_modules"].includes(part))
          || /[\\%?#]/.test(target)) return undefined;
        candidates.push(path.posix.join(scope.directory, target));
      } else if (specifier.startsWith("#")) {
        const scope = this.packages.get(path.posix.dirname(from));
        const target = scope?.imports?.[specifier];
        // Conditions and subpath patterns depend on runtime selection.
        // A plain local target has the same identity at every observation.
        if (scope && typeof target === "string" && target.startsWith("./")
          && !target.slice(2).split("/").some(part => !part || [".", "..", "node_modules"].includes(part))
          && !/[\\%?#]/.test(target)) candidates.push(path.posix.join(scope.directory, target));
      }
      firstCompilerTarget = candidates.length;
      const match = this.pathMatch(config.paths, specifier, budget);
      if (match) for (const target of match.targets) {
        budget.take();
        candidates.push(path.posix.join(config.base, match.replacement ? target.replace("*", match.replacement) : target));
      }
      // A paths target may be relative to the config without a baseUrl.
      // Ordinary bare specifiers still refer to packages or Node built-ins.
      if (typeof config.raw.baseUrl === "string") candidates.push(path.posix.join(config.base, specifier));
    }
    for (const [index, candidate] of candidates.entries()) {
      const base = path.posix.normalize(candidate), compilerOnly = index >= firstCompilerTarget;
      if (base.startsWith("../") || path.posix.isAbsolute(base)) continue;
      const extension = path.posix.extname(base);
      // An explicit executable JS import uses the file Node will actually run
      // when a neighboring TypeScript source also exists.
      if (/\.[cm]?jsx?$/.test(from) && /\.[cm]?jsx?$/.test(extension) && this.sources.has(base)) return { file: base, compilerOnly };
      const replacements: Record<string, string[]> = { ".js": [".ts", ".tsx", ".js", ".jsx"], ".mjs": [".mts", ".mjs"], ".cjs": [".cts", ".cjs"], ".jsx": [".tsx", ".ts", ".jsx", ".js"] };
      const extensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
      // TypeScript probes every direct file before falling back to a directory
      // index. Interleaving these can bind ./db to db/index.ts over db.tsx.
      const files = replacements[extension]?.map(ext => base.slice(0, -extension.length) + ext)
        ?? [base, ...extensions.map(ext => base + ext), ...extensions.map(ext => base + "/index" + ext)];
      for (const file of files) { budget.take(); if (this.sources.has(file)) return { file, compilerOnly }; }
    }
    return undefined;
  }
}
