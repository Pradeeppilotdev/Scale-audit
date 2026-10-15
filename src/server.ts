import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { runAudit } from "./runner.js";
import { renderHtml } from "./reportHtml.js";
import type { Report } from "./types.js";

interface Job {
  id: string;
  repo: string;
  verify: boolean;
  status: "queued" | "running" | "done" | "error";
  createdAt: string;
  report?: Report;
  error?: string;
}

const jobs = new Map<string, Job>();
const queue: string[] = [];
const MAX_CONCURRENCY = Number(process.env.SCALE_AUDIT_CONCURRENCY ?? 2);
let running = 0;

function enqueue(repo: string, verify: boolean): Job {
  const job: Job = { id: randomUUID(), repo, verify, status: "queued", createdAt: new Date().toISOString() };
  jobs.set(job.id, job);
  queue.push(job.id);
  pump();
  return job;
}

function pump() {
  while (running < MAX_CONCURRENCY && queue.length > 0) {
    const id = queue.shift()!;
    const job = jobs.get(id);
    if (!job) continue;
    running++;
    job.status = "running";
    runAudit(job.repo, { verifyFixes: job.verify })
      .then((report) => {
        job.report = report;
        job.status = "done";
      })
      .catch((err) => {
        job.error = err instanceof Error ? err.message : String(err);
        job.status = "error";
      })
      .finally(() => {
        running--;
        pump();
      });
  }
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").slice(0, 10_000);
  return raw ? JSON.parse(raw) : {};
}

const REMOTE_REPO = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/i;
const REMOTE_GIT = /^git@github\.com:[\w.-]+\/[\w.-]+(?:\.git)?$/i;
const ALLOW_LOCAL = process.env.SCALE_AUDIT_ALLOW_LOCAL === "1";

function isAllowedRepo(repo: string): boolean {
  if (REMOTE_REPO.test(repo) || REMOTE_GIT.test(repo)) return true;
  if (ALLOW_LOCAL && (repo.startsWith("/") || repo.startsWith("./") || repo.startsWith("../") || repo.startsWith("~"))) return true;
  return false;
}

function pruneJobs() {
  if (jobs.size < 200) return;
  const done = [...jobs.values()].filter((j) => j.status === "done" || j.status === "error").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const j of done.slice(0, Math.max(0, jobs.size - 150))) jobs.delete(j.id);
}

function send(res: ServerResponse, status: number, body: string, type = "text/plain") {
  res.writeHead(status, { "content-type": type });
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
<script>
const f=document.getElementById('f'),out=document.getElementById('out');
f.addEventListener('submit',async(e)=>{
  e.preventDefault();
  const repo=document.getElementById('repo').value;
  out.style.display='block';out.textContent='queued...';
  const r=await fetch('/api/audit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({repo})});
  const j=await r.json();
  if(!j.id){out.textContent='error: '+(j.error||'unknown');return}
  const poll=setInterval(async()=>{
    const s=await (await fetch('/api/jobs/'+j.id)).json();
    out.textContent='status: '+s.status+(s.error?'\\nerror: '+s.error:'');
    if(s.status==='done'){clearInterval(poll);location.href='/report/'+j.id}
    if(s.status==='error'){clearInterval(poll)}
  },1500);
});
</script></div></body></html>`;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, HOME, "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, JSON.stringify({ ok: true, jobs: jobs.size, running }), "application/json");
    }

    if (req.method === "POST" && url.pathname === "/api/audit") {
      const body = await readJson(req);
      const repo = String(body.repo ?? "").trim();
      if (!repo) return send(res, 400, JSON.stringify({ error: "repo is required" }), "application/json");
      if (!isAllowedRepo(repo)) {
        return send(res, 400, JSON.stringify({ error: "only public github.com repo URLs are allowed" }), "application/json");
      }
      pruneJobs();
      const job = enqueue(repo, Boolean(body.verify));
      return send(res, 202, JSON.stringify({ id: job.id, status: job.status }), "application/json");
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([\w-]+)$/);
    if (req.method === "GET" && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) return send(res, 404, JSON.stringify({ error: "not found" }), "application/json");
      return send(res, 200, JSON.stringify(job), "application/json");
    }

    const reportMatch = url.pathname.match(/^\/report\/([\w-]+)$/);
    if (req.method === "GET" && reportMatch) {
      const job = jobs.get(reportMatch[1]);
      if (!job || !job.report) return send(res, 404, "report not ready");
      return send(res, 200, renderHtml(job.report), "text/html; charset=utf-8");
    }

    send(res, 404, "not found");
  } catch (err) {
    send(res, 500, JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), "application/json");
  }
});

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
server.listen(port, host, () => {
  console.log(`scale-audit web listening on http://${host}:${port}`);
});

function shutdown(signal: string) {
  console.log(`received ${signal}, draining connections`);
  server.close(() => process.exit(0));
  // Do not hang forever on keep-alive connections.
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
