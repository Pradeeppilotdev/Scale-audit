import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { AnalysisBudget } from "../dist/analysisBudget.js";
import { axiosDefaultsAt, currentImportedBinding, initializeBindings } from "../dist/bindings.js";
import { ModuleEffects } from "../dist/moduleEffects.js";
import { SourceProject } from "../dist/project.js";

async function project(t, files) {
  const root = await mkdtemp(join(tmpdir(), "scale-module-mutation-work-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const units = files.map(([rel, source]) => ({rel, sf: ts.createSourceFile(rel, source,
    ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)}));
  const graph = await SourceProject.create(root, units);
  await initializeBindings(root, units, graph);
  return graph;
}

function measure(run) {
  const take = AnalysisBudget.prototype.take;
  let units = 0;
  AnalysisBudget.prototype.take = function(count = 1) {
    if (this.label === "Module mutation provenance") units += count;
    return take.call(this, count);
  };
  try { run(); return units; }
  finally { AnalysisBudget.prototype.take = take; }
}

for (const manyRoutes of [true, false]) {
  test(`module initialization order shares traversal across ${manyRoutes ? "consumers" : "writers"}`, async t => {
    const used = [];
    for (const size of [80, 160]) {
      const files = [["setup.mjs", "import api from 'axios'; api.defaults.timeout = 250;"]];
      for (let i = 0; i < size; i++) {
        const previous = i === 0 ? "setup.mjs" : `shared${i - 1}.mjs`;
        files.push([`shared${i}.mjs`, `import './${previous}';`]);
      }
      for (let i = 0; i < (manyRoutes ? size : 1); i++) {
        files.push([`route${i}.mjs`, `import './shared${size - 1}.mjs'; import api from 'axios'; export function GET(){return api.get('/test');}`]);
      }
      const graph = await project(t, files);
      used.push(measure(() => {
        if (manyRoutes) {
          for (let i = 0; i < size; i++) {
            const sf = graph.sources.get(`route${i}.mjs`);
            const call = sf.statements.at(-1).body.statements[0].expression;
            assert.equal(axiosDefaultsAt(currentImportedBinding(call.expression), call).timeout.text, "250");
          }
        } else {
          const effects = new ModuleEffects(graph, expression => ts.isStringLiteralLike(expression) ? expression.text : undefined);
          const reader = graph.sources.get("route0.mjs");
          for (let i = 0; i < size; i++) {
            assert.equal(effects.writerOrder(graph.sources.get(`shared${i}.mjs`), reader), "before");
          }
        }
      }));
    }
    assert.ok(used[0] > 0 && used[1] < 2.3 * used[0], `module graph work for 80/160: ${used}`);
  });
}
