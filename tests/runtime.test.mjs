import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REQUIRED_NODE, isSupportedNode, assertSupportedNode } from "../dist/runtime.js";

const root = fileURLToPath(new URL("..", import.meta.url));

test("runtime requirement stays aligned with published package engines", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(REQUIRED_NODE, pkg.engines.node);
});

test("runtime accepts patched stable releases and rejects older, unsupported and prerelease versions", () => {
  for (const version of ["22.23.4", "22.24.0", "24.22.1", "24.23.0", "26.12.1", "26.13.0", "27.0.0", "v26.12.1"]) {
    assert.equal(isSupportedNode(version), true, version);
    assert.doesNotThrow(() => assertSupportedNode(version));
  }
  for (const version of ["20.20.0", "21.0.0", "22.23.3", "22.22.99", "23.99.0", "24.22.0", "25.99.0", "26.12.0", "26.11.99", "26.12.1-rc.1", "26.12", "garbage", "", "99999999999999999999.0.0"]) {
    assert.equal(isSupportedNode(version), false, version);
    assert.throws(() => assertSupportedNode(version), /Upgrade to a supported security-patched Node.js release/, version);
  }
});

for (const entry of ["cli", "server"]) {
  test(`${entry} rejects an unsupported runtime before scanning or listening`, () => {
    const preload = "data:text/javascript," + encodeURIComponent('Object.defineProperty(process.versions, "node", { value: "24.22.0" });');
    const result = spawnSync(process.execPath, ["--import", preload, `dist/${entry}.js`, "--help"], { cwd: root, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Unsupported Node.js 24\.22\.0/);
    assert.match(result.stderr, /24\.22\.1/);
    assert.doesNotMatch(result.stderr, /listen EPERM/);
  });
}
