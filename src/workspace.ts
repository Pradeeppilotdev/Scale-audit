import { initializeBindings } from "./bindings.js";
import type { AuditCoverage } from "./types.js";
import ts from "typescript";
import { SourceProject } from "./project.js";
import { listSourceFiles, readFileSafe, parseSource } from "./detectors/common.js";
import { buildContext, type FileContext } from "./context.js";
import { loadSchemaGroups, schemaModelNames } from "./prisma.js";
import { MAX_SOURCE_BYTES, RepoInputBudget } from "./repoFiles.js";

export interface SourceUnit {
  /** Path relative to the repo root. */
  rel: string;
  content: string;
  sf: ts.SourceFile;
  ctx: FileContext;
}

/**
 * A parsed view of the repository, built once and shared by every detector.
 *
 * Previously each detector re-globbed, re-read and re-parsed every file, so an
 * 8-detector run parsed the same AST eight times. Now it happens once.
 */
export class Workspace {
  readonly coverage: AuditCoverage;
  readonly root: string;
  readonly units: SourceUnit[];
  readonly schemaGroups: Awaited<ReturnType<typeof loadSchemaGroups>>;

  private constructor(root: string, units: SourceUnit[], schemaGroups: Awaited<ReturnType<typeof loadSchemaGroups>>, coverage: AuditCoverage) {
    this.coverage = coverage;
    this.root = root;
    this.units = units;
    this.schemaGroups = schemaGroups;
  }

  static async load(root: string, sourceFile?: string, previous?: Workspace): Promise<Workspace> {
    const reuse = previous?.root === root ? previous : undefined;
    const schemaGroups = reuse?.schemaGroups ?? await loadSchemaGroups(root);
    const previousText = new Map(reuse?.units.map(unit => [unit.rel, unit.content]));
    const schemaModels = schemaModelNames(schemaGroups);

    const rels = sourceFile ? [sourceFile] : await listSourceFiles(root);
    const project = await SourceProject.create(root, rels.map(rel => ({ rel })), !!sourceFile);
    const moduleFile = async (rel: string): Promise<boolean> => {
      // One bounded per-directory lookup supplies format, package imports and
      // the package's own exported targets, including for .mjs and .cts files.
      const scope = await project.packageScope(rel);
      if (/\.(mts|mjs)$/.test(rel)) return true;
      if (/\.(cts|cjs)$/.test(rel)) return false;
      const detection = project.compilerOptions(rel).moduleDetection;
      if (typeof detection === "string" && detection.toLowerCase() === "force") return true;
      return scope?.esm ?? false;
    };
    const coverage: AuditCoverage = { discovered: rels.length, analyzed: 0, skipped: [] };
    const units: SourceUnit[] = [];
    const budget = new RepoInputBudget("source", MAX_SOURCE_BYTES);
    for (const rel of rels) {
      const content = previousText.get(rel) ?? await readFileSafe(root, rel);
      if (content === null) {
        coverage.skipped.push({ file: rel, reason: "Unsafe, unreadable, changed, or larger than 1000000 bytes" });
        continue;
      }
      budget.add(content);
      const sf = parseSource(rel, content, await moduleFile(rel));
      if (!sf || (sf as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) {
        coverage.skipped.push({ file: rel, reason: "Source contains syntax errors or could not be parsed" });
        continue;
      }
      coverage.analyzed++;
      units.push({ rel, content, sf, ctx: buildContext(sf, schemaModels) });
    }
    await initializeBindings(root, units, project);
    return new Workspace(root, units, schemaGroups, coverage);
  }
}
