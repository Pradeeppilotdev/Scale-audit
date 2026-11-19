import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AnalysisBudget } from "../dist/analysisBudget.js";
import { detectInProcessState } from "../dist/detectors/inProcessState.js";
import { Workspace } from "../dist/workspace.js";

async function fixture(t, source) {
  const root = await mkdtemp(join(tmpdir(), "scale-state-import-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "server.ts"), source);
  return { root, workspace: await Workspace.load(root) };
}
const aliases = (count, initial) => `const a0 = ${initial};` +
  Array.from({ length: count }, (_, index) => `const a${index + 1} = a${index};`).join("");
async function measure(run) {
  const take = AnalysisBudget.prototype.take;
  let work = 0;
  AnalysisBudget.prototype.take = function (count = 1) {
    if (this.label === "Promise binding writes") work += count;
    return take.call(this, count);
  };
  try { return { result: await run(), work }; }
  finally { AnalysisBudget.prototype.take = take; }
}

test("unrelated shared import origins grow near linearly and retain cached unknowns", async t => {
  const run = async (depth, calls) => {
    const source = aliases(depth, "{ cache: new Map() }") + `a${depth}.cache.get(key);`.repeat(calls);
    const { root, workspace } = await fixture(t, source);
    const first = await measure(() => detectInProcessState(root, workspace));
    const second = await measure(() => detectInProcessState(root, workspace));
    assert.deepEqual(first.result, []); assert.deepEqual(second.result, []);
    assert.ok(second.work < first.work / 10, `${first.work} -> ${second.work}`);
    return first.work;
  };
  const one = await run(30, 1000), two = await run(60, 2000);
  assert.ok(two < one * 2.3, `${one} -> ${two}`);
});

test("repeated cyclic aliases remain cached unknown origins within the existing depth limit", async t => {
  const cycle = Array.from({ length: 60 }, (_, index) => `const a${index} = a${(index + 1) % 60};`).join("");
  const { root, workspace } = await fixture(t, cycle + "a0();".repeat(2000));
  const first = await measure(() => detectInProcessState(root, workspace));
  const second = await measure(() => detectInProcessState(root, workspace));
  assert.deepEqual(first.result, []); assert.deepEqual(second.result, []);
  assert.ok(second.work < first.work / 10, `${first.work} -> ${second.work}`);
});

for (const origin of ["session", "{}"])
  for (const warmed of [false, true]) test(`${warmed ? "warm" : "cold"} ${origin} import origins retain depth exhaustion on repeated audits`, async t => {
    const source = "import session from 'express-session';" + aliases(128, origin) +
      (warmed ? "a60();" : "") + "a128();";
    const { root, workspace } = await fixture(t, source);
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(detectInProcessState(root, workspace), /Binding resolution depth limit exceeded/);
    }
  });

test("a warm cycle cannot erase the depth of a longer alias prefix", async t => {
  const cycle = Array.from({ length: 128 }, (_, index) => `const a${index} = a${(index + 1) % 128};`).join("");
  const bounded = await fixture(t, cycle + "a0();");
  assert.deepEqual(await detectInProcessState(bounded.root, bounded.workspace), []);
  const deeper = await fixture(t, cycle + "a0(); const longer = a0; longer();");
  await assert.rejects(detectInProcessState(deeper.root, deeper.workspace), /Binding resolution depth limit exceeded/);
});

test("cached middleware identities retain assignment positions and captured aliases", async t => {
  const { root, workspace } = await fixture(t, `import session from 'express-session';
    let current = session;
    const captured = current;
    current({});
    current = () => ({});
    current({});
    captured({});
    current = session;
    current({});`);
  const first = await detectInProcessState(root, workspace), second = await detectInProcessState(root, workspace);
  assert.deepEqual(first.map(finding => finding.line), [4, 7, 9]);
  assert.deepEqual(second, first);
});
