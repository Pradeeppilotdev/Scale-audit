import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectQueueBackpressure } from "../dist/detectors/queueBackpressure.js";

const policies = [
  { name: "equal-three", kind: "equal", cap: 3, size: 1 },
  { name: "equal-four", kind: "equal", cap: 4, size: 1 },
  { name: "at-least-three", kind: "range", cap: 3, size: 1 },
  { name: "at-least-four", kind: "range", cap: 4, size: 1 },
  { name: "truthiness", kind: "truthy", cap: 0, size: 1 },
  { name: "sparse-equal-three", kind: "equal", cap: 3, size: 1, array: "[, 1]" },
  { name: "open", kind: "open", cap: 0, size: 1 },
  { name: "batch-outer-equal-three", kind: "equal", cap: 3, size: 2, array: "[1, 1]" },
  { name: "batch-inner-equal-three", kind: "equal", cap: 3, size: 2, array: "[1, 1]", inner: true },
];

function rejects(policy, count) {
  if (policy.kind === "equal") return count === policy.cap;
  if (policy.kind === "range") return count >= policy.cap;
  return policy.kind === "truthy" && count !== 0;
}

// An independent integer-state model explores every route/drain interleaving.
// Above all thresholds plus one batch, a further increase establishes an
// unlimited path for these fixed equality/range/truthiness policies.
function bounded(routes) {
  const ceiling = Math.max(...routes.map(route => route.cap)) + Math.max(...routes.map(route => route.size)) + 1;
  const pending = [0], seen = new Set(pending);
  const include = count => { if (!seen.has(count)) { seen.add(count); pending.push(count); } };
  while (pending.length) {
    const count = pending.pop();
    if (count > 0) include(count - 1);
    for (const route of routes) {
      if (!route.inner && rejects(route, count)) continue;
      let next = count;
      for (let index = 0; index < route.size; index++) {
        if (route.inner && rejects(route, next)) break;
        next++;
      }
      if (next > ceiling) return false;
      include(next);
    }
  }
  return true;
}

function handler(policy, helper) {
  const condition = policy.kind === "equal" ? `count === ${policy.cap}`
    : policy.kind === "range" ? `count >= ${policy.cap}` : policy.kind === "truthy" ? "count" : undefined;
  const check = `${condition ? `if (${condition}) return;` : ""} if (Boolean(full())) return;`;
  const push = helper ? "enqueue(1);" : "jobs.push(1); count++;";
  if (!policy.array) return `${check} ${push}`;
  const callback = `() => { ${policy.inner ? check : ""} ${push} }`;
  return `${policy.inner ? "" : check} ${policy.array}.forEach(${callback});`;
}

for (const helper of [false, true]) for (const first of policies) for (const second of policies) {
  test(`${helper ? "helper" : "direct"} queue policies ${first.name} / ${second.name} agree with the state model`, async () => {
    const root = await mkdtemp(join(tmpdir(), "scale-route-policy-oracle-"));
    try {
      await writeFile(join(root, "server.ts"), `import { createServer } from 'node:http';
        const jobs = []; let count = 0;
        function full() { return count >= 11; }
        function drain(job) { if (job !== undefined) count--; }
        setInterval(() => drain(jobs.shift()), 100);
        globalThis.Boolean = () => false;
        ${helper ? "function enqueue(job) { jobs.push(job); count++; }" : ""}
        createServer(req => { ${handler(first, helper)} });
        createServer(req => { ${handler(second, helper)} });`);
      const findings = await detectQueueBackpressure(root);
      assert.equal(findings.length, bounded([first, second]) ? 0 : 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
