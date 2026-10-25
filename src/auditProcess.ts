import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Report } from "./types.js";

export interface AuditProcessOptions {
  timeoutMs?: number;
  memoryMb?: number;
  maxReportBytes?: number;
}

export function positiveInteger(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return number;
}

/** Deliberately do not inherit NODE_OPTIONS, test loaders, credentials, proxies, or Git config. */
export function auditEnvironment(directory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: directory,
    USERPROFILE: directory,
    XDG_CONFIG_HOME: directory,
    TMPDIR: directory,
    TMP: directory,
    TEMP: directory,
    LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: path.join(directory, "no-system-config"),
    GIT_CONFIG_GLOBAL: path.join(directory, "no-global-config"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "5",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: path.join(directory, "no-hooks"),
    GIT_CONFIG_KEY_2: "protocol.allow",
    GIT_CONFIG_VALUE_2: "never",
    GIT_CONFIG_KEY_3: "protocol.https.allow",
    GIT_CONFIG_VALUE_3: "always",
    GIT_CONFIG_KEY_4: "http.followRedirects",
    GIT_CONFIG_VALUE_4: "false",
  };
  return env;
}

export function createAuditProcessRunner(options: AuditProcessOptions = {}) {
  const timeoutMs = positiveInteger(options.timeoutMs ?? 120_000, "audit timeout", 2_147_483_647);
  const memoryMb = positiveInteger(options.memoryMb ?? 512, "audit memory", 4096);
  const maxReportBytes = positiveInteger(options.maxReportBytes ?? 2_000_000, "report byte limit", 16_000_000);
  const active = new Set<() => void>();
  let closed = false;

  async function audit(repo: string): Promise<Report> {
    if (closed) throw new Error("audit runner is closed");
    const directory = await mkdtemp(path.join(tmpdir(), "scale-audit-worker-"));
    if (closed) {
      await rm(directory, { recursive: true, force: true });
      throw new Error("audit runner is closed");
    }
    try {
      return await new Promise<Report>((resolve, reject) => {
        let child: ChildProcess;
        let failure: Error | undefined;
        let bytes = 0;
        const chunks: Buffer[] = [];
        const terminate = () => {
          if (!child?.pid) return;
          // Git descendants must not outlive a timed-out audit. Windows lacks POSIX groups.
          try {
            if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch { /* The process may already have exited. */ }
        };
        const stop = (message: string) => {
          failure ??= new Error(message);
          chunks.length = 0;
          terminate();
        };
        const cancel = () => stop("audit cancelled during shutdown");
        try {
          child = spawn(process.execPath, [
            `--max-old-space-size=${memoryMb}`,
            fileURLToPath(new URL("./auditWorker.js", import.meta.url)),
            repo,
            String(maxReportBytes),
          ], {
            cwd: directory,
            env: auditEnvironment(directory),
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "ignore"],
          });
        } catch (error) {
          reject(error);
          return;
        }
        active.add(cancel);
        const timer = setTimeout(() => stop("audit timed out"), timeoutMs);
        child.stdout!.on("data", (chunk: Buffer) => {
          if (failure) return;
          bytes += chunk.length;
          if (bytes > maxReportBytes) {
            chunks.length = 0;
            stop("audit report exceeds byte limit");
          } else {
            chunks.push(chunk);
          }
        });
        child.on("error", () => stop("audit process failed to start"));
        child.on("exit", terminate);
        child.on("close", (code) => {
          clearTimeout(timer);
          active.delete(cancel);
          terminate();
          // A timeout/shutdown can race with a successful exit; never accept that result.
          if (failure) return reject(failure);
          if (code !== 0) return reject(new Error(code === 2 ? "audit report exceeds byte limit" : "audit process failed"));
          try {
            resolve(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as Report);
          } catch {
            reject(new Error("invalid audit process response"));
          }
        });
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  function close() {
    closed = true;
    for (const cancel of active) cancel();
  }

  return { audit, close };
}
