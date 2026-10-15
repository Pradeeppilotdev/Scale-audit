import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = path.join(root, "dist", "server.js");
const fixture = path.join(root, "tests", "fixtures", "badapp");

test("web server runs an audit and serves an HTML report", async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [server], { env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  const base = `http://localhost:${port}`;
  try {
    await waitForReady(base);
    const created = await fetch(`${base}/api/audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: fixture }),
    });
    assert.equal(created.status, 202);
    const { id } = await created.json();

    const deadline = Date.now() + 20_000;
    let status = "queued";
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/api/jobs/${id}`);
      const job = await res.json();
      status = job.status;
      if (status === "done" || status === "error") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(status, "done");

    const report = await fetch(`${base}/report/${id}`);
    assert.equal(report.status, 200);
    const html = await report.text();
    assert.match(html, /Scale-Readiness Report/);
  } finally {
    child.kill("SIGTERM");
  }
});

async function waitForReady(base) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}
