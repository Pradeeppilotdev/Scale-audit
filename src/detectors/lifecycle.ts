import { readFile } from "node:fs/promises";
import path from "node:path";
import { listSourceFiles, readFileSafe, snippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";

const HEALTH_ROUTE = /["'`]\/(health|healthz|live|ready|readiness)["'`]/i;
const LISTEN_CALL = /(\bapp\.listen\s*\(|\bcreateServer\s*\(|\.listen\s*\()/;
const SHUTDOWN_HANDLER = /process\.(on|once)\s*\(\s*["'`](SIGTERM|SIGINT)["'`]|enableShutdownHooks/;

export async function detectLifecycle(root: string): Promise<Finding[]> {
  const out: Finding[] = [];

  let pkg: any = {};
  try { pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")); } catch {}
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const hasServerFramework = Boolean(deps.express || deps.fastify || deps["@nestjs/core"] || deps.koa || deps["@hapi/hapi"] || deps.next);

  const files = await listSourceFiles(root);
  let serverFile: { rel: string; content: string; line: number } | null = null;
  let hasHealthRoute = false;
  let hasShutdownHandler = false;

  for (const rel of files) {
    const content = await readFileSafe(root, rel);
    if (!content) continue;
    if (HEALTH_ROUTE.test(content)) hasHealthRoute = true;
    if (SHUTDOWN_HANDLER.test(content)) hasShutdownHandler = true;
    if (!serverFile) {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (LISTEN_CALL.test(lines[i])) {
          serverFile = { rel, content, line: i + 1 };
          break;
        }
      }
    }
  }

  if (serverFile && !hasHealthRoute && hasServerFramework) {
    out.push(
      makeFinding({
        id: "missing-health-endpoint",
        category: "Observability",
        severity: "low",
        confidence: "medium",
        file: serverFile.rel,
        line: serverFile.line,
        message: "No health/liveness endpoint found in the repo.",
        scaleTrigger: "Load balancers/orchestrators cannot detect unhealthy instances, causing bad traffic routing during incidents.",
        suggestedFix: "Add GET /health (liveness) and GET /ready (readiness) with a cheap DB/queue check for readiness.",
        snippet: snippetAt(serverFile.content, serverFile.line),
      }),
    );
  }

  if (serverFile && !hasShutdownHandler) {
    out.push(
      makeFinding({
        id: "missing-graceful-shutdown",
        category: "Resilience",
        severity: "medium",
        confidence: "medium",
        file: serverFile.rel,
        line: serverFile.line,
        message: "Server does not handle SIGTERM/SIGINT for graceful shutdown.",
        scaleTrigger: "On deploys/scale-down, in-flight requests fail and DB/connection cleanup is skipped.",
        suggestedFix: "Handle SIGTERM: stop accepting connections, drain in-flight requests with a timeout, then close DB/queue clients.",
        snippet: snippetAt(serverFile.content, serverFile.line),
      }),
    );
  }

  return out;
}
