import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAudit } from "../dist/runner.js";

// An offline client with Axios's two relevant calling conventions. A wrong
// insertion is visible in the payload, effective deadline or argument count.
const clientSource = `const defaults = {timeout: 0};
  export default {
    defaults,
    get(url, config) { return {method: "get", timeout: config?.timeout ?? defaults.timeout}; },
    post(url, body, config) { return {method: "post", body, timeout: config?.timeout ?? defaults.timeout}; }
  };`;
const scenarios = {
  method: {
    setup: "api.get = api.post;",
    call: "api.get('/health', {id: 123})",
    expected: {method: "post", body: {id: 123}, timeout: 0},
  },
  deadline: {
    setup: "api.defaults.timeout = 250;",
    call: "api.get('/health')",
    expected: {method: "get", timeout: 250},
  },
  local: {
    setup: "api.get = (...args) => args.length;",
    call: "api.get('/health')",
    expected: 1,
  },
};

async function fixture(t, linkage, scenario) {
  const root = await mkdtemp(join(tmpdir(), "scale-timeout-context-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const client = join(root, "node_modules", "axios");
  await mkdir(client, {recursive: true});
  await writeFile(join(client, "package.json"), JSON.stringify({type: "module", exports: "./index.mjs"}));
  await writeFile(join(client, "index.mjs"), clientSource);
  await writeFile(join(root, "package.json"), JSON.stringify({type: "module", imports: {"#setup": "./setup.mjs"}}));
  await writeFile(join(root, "setup.mjs"), `import api from "axios";\n${scenario.setup}\n`);
  const imports = {
    upstream: "",
    packageImport: "import '#setup';",
    computed: "const startup = './setup.mjs';\nawait import(startup);",
    bridge: "import './bridge.mjs';",
  };
  if (linkage === "upstream") await writeFile(join(root, "app.mjs"), "import './setup.mjs';\nexport {GET} from './route.mjs';");
  if (linkage === "bridge") await writeFile(join(root, "bridge.mjs"), "import '#setup';");
  const route = join(root, "route.mjs");
  await writeFile(route, `import api from "axios";\n${imports[linkage]}\nexport function GET(){\n return ${scenario.call};\n}\n`);
  return {root, route, entry: linkage === "upstream" ? "./app.mjs" : "./route.mjs"};
}

function execute(root, entry) {
  // A fresh loader observes both startup order and the actual edited source.
  const source = `import {GET} from ${JSON.stringify(entry)}; console.log(JSON.stringify(await GET()));`;
  const proc = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {cwd: root, encoding: "utf8"});
  assert.equal(proc.status, 0, proc.stderr);
  return JSON.parse(proc.stdout);
}

for (const [linkage, singleFile, name] of [
  ["upstream", true, "method"],
  ["upstream", true, "deadline"],
  ["upstream", true, "local"],
  ["packageImport", false, "method"],
  ["packageImport", true, "method"],
  ["packageImport", false, "deadline"],
  ["computed", false, "method"],
  ["computed", true, "method"],
  ["bridge", false, "method"],
]) {
  test(`timeout edit preserves ${name} through ${linkage} startup in ${singleFile ? "single-file" : "workspace"} mode`, async t => {
    const scenario = scenarios[name];
    const {root, route, entry} = await fixture(t, linkage, scenario);
    const before = execute(root, entry);
    assert.deepEqual(before, scenario.expected);
    const report = await runAudit(singleFile ? route : root, {codemod: "apply"});
    assert.equal(report.complete, true);
    const after = execute(root, entry);
    if (name === "method" && report.codemod.appliedEdits) {
      // A proven POST may receive a separate options object after its body.
      assert.deepEqual(after, {...before, timeout: 5000});
    } else {
      assert.equal(report.codemod.appliedEdits, 0);
      assert.deepEqual(after, before);
    }
  });
}
