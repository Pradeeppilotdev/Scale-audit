import { PREVIEW_SCRIPT } from "./previewUi.js";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createAuditProcessRunner, positiveInteger, type AuditProcessOptions } from "./auditProcess.js";
import { checkRequestOrigin, readJson, RequestError } from "./serverSafety.js";
import { renderHtml } from "./reportHtml.js";
import type { Report } from "./types.js";
import { assertSupportedNode } from "./runtime.js";

interface Job {
  id: string;
  repo: string;
  status: "queued" | "running" | "done" | "error";
  createdAt: string;
  report?: Report;
  expiresAt?: number;
  error?: string;
}

const REMOTE_REPO = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/i;
const REMOTE_GIT = /^git@github\.com:[\w.-]+\/[\w.-]+(?:\.git)?$/i;

function send(res: ServerResponse, status: number, body: string, type = "text/plain") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
}

const HOME = `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>scale-audit</title>
<style>
body{margin:0;background:#0b0f17;color:#e6edf3;font:15px/1.5 system-ui,sans-serif}
.wrap{max-width:720px;margin:10vh auto;padding:0 20px}
h1{font-size:24px}.muted{color:#8b949e;font-size:13px}
form{display:flex;gap:8px;margin:24px 0}
input{flex:1;background:#121826;border:1px solid #253041;color:#e6edf3;border-radius:8px;padding:12px}
button{background:#238636;border:0;color:#fff;border-radius:8px;padding:12px 18px;cursor:pointer}
pre{background:#121826;border:1px solid #253041;border-radius:8px;padding:12px;overflow:auto}
</style></head>
<body><div class="wrap">
<h1>scale-audit</h1>
<p class="muted">Paste a public GitHub repo URL (Node/TS). We clone read-only, analyze statically, and produce a shareable scale-readiness report.</p>
<form id="f"><input id="repo" placeholder="https://github.com/owner/repo" required/><button>Audit</button></form>
<pre id="out" style="display:none"></pre>
<script>${PREVIEW_SCRIPT}
</script></div></body></html>`;

export interface AuditServerOptions extends AuditProcessOptions {
  host?: string;
  port?: number;
  concurrency?: number;
  maxJobs?: number;
  reportTtlMs?: number;
  allowLocal?: boolean;
  /** Trusted test/embedding hook only. Production uses a killable subprocess. */
  audit?: (repo: string) => Promise<Report>;
  now?: () => number;
}

export function createAuditServer(options: AuditServerOptions = {}) {
  assertSupportedNode();
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid server port");
  const concurrency = positiveInteger(options.concurrency ?? 2, "concurrency", 32);
  const maxJobs = positiveInteger(options.maxJobs ?? 200, "job limit", 10_000);
  const reportTtlMs = positiveInteger(options.reportTtlMs ?? 15 * 60_000, "report TTL", 2_147_483_647);
  const maxReportBytes = positiveInteger(options.maxReportBytes ?? 2_000_000, "report byte limit", 16_000_000);
  const now = options.now ?? Date.now;
  const processRunner = options.audit ? undefined : createAuditProcessRunner(options);
  const audit = options.audit ?? processRunner!.audit;
  const jobs = new Map<string, Job>();
  const queue: Job[] = [];
  const pending = new Set<Promise<void>>();
  const hits = new Map<string, { start: number; count: number }>();
  let running = 0;
  let closed = false;

  function pruneJobs() {
    const time = now();
    for (const [id, job] of jobs) if (job.expiresAt !== undefined && job.expiresAt <= time) jobs.delete(id);
    for (const [ip, hit] of hits) if (time - hit.start >= 60_000) hits.delete(ip);
  }
  const expiryTimer = setInterval(pruneJobs, Math.min(reportTtlMs, 60_000));
  expiryTimer.unref();

  function pump() {
    while (!closed && running < concurrency && queue.length) {
      const job = queue.shift()!;
      running++;
      job.status = "running";
      const task = Promise.resolve().then(() => audit(job.repo)).then((report) => {
        const serialized = JSON.stringify(report);
        if (Buffer.byteLength(serialized) > maxReportBytes) throw new Error("audit report exceeds byte limit");
        job.report = report;
        job.status = "done";
      }).catch((error: unknown) => {
        job.error = error instanceof Error ? error.message.slice(0, 500) : "audit failed";
        job.status = "error";
      }).finally(() => {
        job.expiresAt = now() + reportTtlMs;
        running--;
        pending.delete(task);
        pump();
      });
      pending.add(task);
    }
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    req.once("error", () => {});
    // Rejections need not drain attacker-controlled bodies. Send the response, then close
    // the connection (rather than destroying the request before the response is written).
    if (req.method !== "GET" && req.method !== "HEAD") res.setHeader("connection", "close");
    const json = (status: number, body: unknown) => send(res, status, JSON.stringify(body), "application/json");
    try {
      const address = server.address();
      const listeningPort = address && typeof address !== "string" ? address.port : port;
      if (!checkRequestOrigin(req, host, listeningPort)) return json(403, { error: "foreign host or origin" });
      if (!req.url?.startsWith("/") || req.url.startsWith("//")) return json(400, { error: "invalid request target" });
      const url = new URL(req.url, "http://localhost");
      pruneJobs();
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, HOME, "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/health") return json(200, { ok: !closed, jobs: jobs.size, running });

      if (req.method === "POST" && url.pathname === "/api/audit") {
        if (closed || jobs.size >= maxJobs) return json(503, { error: "audit capacity exhausted" });
        const ip = req.socket.remoteAddress ?? "unknown";
        const hit = hits.get(ip);
        if ((hit?.count ?? 0) >= 10 || (!hit && hits.size >= 1000)) return json(429, { error: "too many requests" });
        hits.set(ip, { start: hit?.start ?? now(), count: (hit?.count ?? 0) + 1 });
        const body = await readJson(req);
        if (!body || typeof body !== "object" || !("repo" in body) || typeof body.repo !== "string" || !body.repo.trim()) {
          return json(400, { error: "repo is required" });
        }
        let repo = body.repo.trim();
        if (REMOTE_GIT.test(repo)) repo = repo.replace(/^git@github\.com:/i, "https://github.com/");
        const local = options.allowLocal && (repo.startsWith("/") || repo.startsWith("./") || repo.startsWith("../"));
        if (!REMOTE_REPO.test(repo) && !local) return json(400, { error: "only public github.com repo URLs are allowed" });
        if (local) repo = resolve(repo);
        // Body reads interleave: capacity must be checked again immediately before enqueue.
        if (closed || jobs.size >= maxJobs) return json(503, { error: "audit capacity exhausted" });
        const job: Job = { id: randomUUID(), repo, status: "queued", createdAt: new Date(now()).toISOString() };
        jobs.set(job.id, job);
        queue.push(job);
        pump();
        return json(202, { id: job.id, status: job.status });
      }

      const jobMatch = url.pathname.match(/^\/api\/jobs\/([\w-]+)$/);
      if (req.method === "GET" && jobMatch) {
        const job = jobs.get(jobMatch[1]);
        if (!job) return json(404, { error: "not found" });
        return json(200, job);
      }
      const reportMatch = url.pathname.match(/^\/report\/([\w-]+)$/);
      if (req.method === "GET" && reportMatch) {
        const job = jobs.get(reportMatch[1]);
        if (!job?.report) return send(res, 404, "report not ready");
        const html = renderHtml(job.report);
        if (Buffer.byteLength(html) > maxReportBytes) return json(413, { error: "rendered report exceeds byte limit" });
        return send(res, 200, html, "text/html; charset=utf-8");
      }
      send(res, 404, "not found");
    } catch (error) {
      if (error instanceof RequestError) return json(error.status, { error: error.message });
      json(500, { error: "internal server error" });
    }
  };
  const server = createServer(handler);
  server.requestTimeout = 30_000;
  server.headersTimeout = 35_000;
  server.keepAliveTimeout = 10_000;

  const stop = () => {
    closed = true;
    clearInterval(expiryTimer);
    queue.length = 0;
    processRunner?.close();
  };
  server.on("close", stop);
  async function close() {
    stop();
    if (server.listening) {
      const drained = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await drained;
    }
    await Promise.all(pending);
    jobs.clear();
    hits.clear();
  }
  return { server, handler, close };
}

// Importing the factory in tests must never bind a port or install signal handlers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertSupportedNode();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  const app = createAuditServer({
    host, port,
    concurrency: positiveInteger(process.env.SCALE_AUDIT_CONCURRENCY ?? 2, "SCALE_AUDIT_CONCURRENCY", 32),
    allowLocal: process.env.SCALE_AUDIT_ALLOW_LOCAL === "1",
  });
  app.server.listen(port, host, () => {
    const address = app.server.address();
    console.log(`scale-audit web listening on http://${host}:${typeof address === "object" && address ? address.port : port}`);
  });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => process.exit(1), 5000);
    deadline.unref();
    void app.close().then(() => { clearTimeout(deadline); });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
