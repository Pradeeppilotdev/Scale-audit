import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

export class RequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function readJson(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json\s*(?:;|$)/i.test(contentType)) {
    throw new RequestError(415, "content-type must be application/json");
  }
  const length = req.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > 10_000)) {
    throw new RequestError(413, "request body exceeds 10000 bytes");
  }
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    const cleanup = () => {
      req.off("data", data);
      req.off("end", end);
      req.off("error", error);
      req.off("aborted", aborted);
    };
    const fail = (reason: Error) => {
      cleanup();
      // IncomingMessage may emit an error after aborted, or when the rejected socket closes.
      req.once("error", () => {});
      req.pause();
      chunks.length = 0;
      reject(reason);
    };
    const data = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 10_000) return fail(new RequestError(413, "request body exceeds 10000 bytes"));
      chunks.push(buffer);
    };
    const error = () => fail(new RequestError(400, "request body interrupted"));
    const aborted = () => fail(new RequestError(400, "request body interrupted"));
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"))); }
      catch { reject(new RequestError(400, "invalid JSON body")); }
    };
    // Event listeners, not async iteration: rejecting an oversized body must not destroy
    // the socket before the server can send its 413 response.
    req.on("data", data);
    req.on("end", end);
    req.on("error", error);
    req.on("aborted", aborted);
  });
}

export function checkRequestOrigin(req: IncomingMessage, host: string, port: number): boolean {
  const hosts = new Set([host.toLowerCase()]);
  if (["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"].includes(host.toLowerCase())) {
    for (const alias of ["127.0.0.1", "localhost", "::1"]) hosts.add(alias);
  }
  hosts.delete("0.0.0.0");
  hosts.delete("::");
  const origins = new Set([...hosts].map((name) => new URL(`http://${isIP(name) === 6 ? `[${name}]` : name}:${port}`).origin));
  const authority = req.headers.host;
  if (!authority || /[\s/@\\?#]/.test(authority)) return false;
  // Do not let a client-chosen Host authorize a client-chosen Origin.
  let hostOrigin: string;
  try { hostOrigin = new URL(`http://${authority}`).origin; }
  catch { return false; }
  if (!origins.has(hostOrigin)) return false;
  const origin = req.headers.origin;
  return origin === undefined || (typeof origin === "string" && origins.has(origin));
}
