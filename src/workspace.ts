import ts from "typescript";
import { listSourceFiles, readFileSafe, parseSource } from "./detectors/common.js";
import { buildContext, type FileContext } from "./context.js";
import { loadSchemaGroups, schemaModelNames } from "./prisma.js";

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
  readonly root: string;
  readonly units: SourceUnit[];
  readonly schemaGroups: Awaited<ReturnType<typeof loadSchemaGroups>>;

  private constructor(root: string, units: SourceUnit[], schemaGroups: Awaited<ReturnType<typeof loadSchemaGroups>>) {
    this.root = root;
    this.units = units;
    this.schemaGroups = schemaGroups;
  }

  static async load(root: string): Promise<Workspace> {
    const schemaGroups = await loadSchemaGroups(root);
    const schemaModels = schemaModelNames(schemaGroups);

    const rels = await listSourceFiles(root);
    const units: SourceUnit[] = [];
    for (const rel of rels) {
      const content = await readFileSafe(root, rel);
      if (!content) continue;
      const sf = parseSource(rel, content);
      if (!sf) continue;
      units.push({ rel, content, sf, ctx: buildContext(sf, schemaModels) });
    }
    return new Workspace(root, units, schemaGroups);
  }
}
