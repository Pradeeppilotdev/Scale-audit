import path from "node:path";
import ts from "typescript";
import { readRepoFile, RepoInputBudget, MAX_MANIFEST_BYTES, isRecord } from "./repoFiles.js";

interface Config { base: string; paths: Record<string, string[]>; raw: Record<string, unknown> }
/** In-repository resolution only: no target code, package hooks or external config is loaded. */
export class SourceProject {
  readonly sources: Map<string, ts.SourceFile>;
  private configs = new Map<string, Config>();
  private byFile = new Map<string, Config>();
  private budget = new RepoInputBudget("TypeScript config", MAX_MANIFEST_BYTES);
  private constructor(private root: string, sources: { rel: string; sf: ts.SourceFile }[]) {
    this.sources = new Map(sources.map(unit => [unit.rel, unit.sf]));
  }
  static async create(root: string, sources: { rel: string; sf: ts.SourceFile }[]): Promise<SourceProject> {
    const project = new SourceProject(root, sources);
    const directories = new Map<string, Config>();
    for (const { rel } of sources) {
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
    const base = typeof options.baseUrl === "string" ? path.posix.normalize(path.posix.join(path.posix.dirname(rel), options.baseUrl))
      : inherited?.base ?? path.posix.dirname(rel);
    const paths: Record<string, string[]> = Object.create(null);
    if (isRecord(options.paths)) for (const [key, value] of Object.entries(options.paths)) {
      if (Array.isArray(value)) paths[key] = value.filter((item): item is string => typeof item === "string");
    }
    const config = { base, paths: isRecord(options.paths) ? paths : inherited?.paths ?? {}, raw: { ...inherited?.raw, ...options } };
    this.configs.set(rel, config);
    return config;
  }
  compilerOptions(from: string): Record<string, unknown> { return this.byFile.get(from)?.raw ?? {}; }
  resolve(from: string, specifier: string): string | undefined {
    const candidates: string[] = [];
    if (specifier.startsWith(".")) candidates.push(path.posix.join(path.posix.dirname(from), specifier));
    else {
      const config: Pick<Config, "base" | "paths"> = this.byFile.get(from) ?? { base: ".", paths: {} };
      const patterns = Object.keys(config.paths).sort((a, b) => Number(b === specifier) - Number(a === specifier) || b.indexOf("*") - a.indexOf("*"));
      for (const pattern of patterns) {
        const star = pattern.indexOf("*");
        const matches = star < 0 ? pattern === specifier : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1));
        if (!matches) continue;
        const replacement = star < 0 ? "" : specifier.slice(star, specifier.length - (pattern.length - star - 1));
        for (const target of config.paths[pattern]) candidates.push(path.posix.join(config.base, target.replace("*", replacement)));
        break;
      }
      candidates.push(path.posix.join(config.base, specifier));
    }
    for (const candidate of candidates) {
      const base = path.posix.normalize(candidate);
      if (base.startsWith("../") || path.posix.isAbsolute(base)) continue;
      const extension = path.posix.extname(base);
      const replacements: Record<string, string[]> = { ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"], ".cjs": [".cts", ".cjs"], ".jsx": [".tsx", ".jsx"] };
      const files = replacements[extension]?.map(ext => base.slice(0, -extension.length) + ext)
        ?? [base, ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].flatMap(ext => [base + ext, base + "/index" + ext])];
      for (const file of files) if (this.sources.has(file)) return file;
    }
    return undefined;
  }
}
