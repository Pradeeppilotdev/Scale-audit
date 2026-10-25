import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { checkRequestOrigin, readJson } from "../dist/serverSafety.js";

const request = (host, origin) => ({ headers: { host, ...(origin === undefined ? {} : { origin }) } });

test("authority allowlist uses the listener configuration, not the incoming Host", () => {
  for (const host of ["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"]) {
    for (const authority of ["localhost:9123", "127.0.0.1:9123", "[::1]:9123"]) {
      assert.equal(checkRequestOrigin(request(authority, `http://${authority}`), host, 9123), true);
    }
    for (const authority of ["evil.example:9123", "localhost:8787", "localhost:9123/path", "localhost:9123#", "localhost:9123\\evil"]) {
      assert.equal(checkRequestOrigin(request(authority, `http://${authority}`), host, 9123), false);
    }
  }
  assert.equal(checkRequestOrigin(request("audit.internal:9000", "http://audit.internal:9000"), "audit.internal", 9000), true);
  assert.equal(checkRequestOrigin(request("localhost:9000"), "audit.internal", 9000), false);
  assert.equal(checkRequestOrigin(request("audit.internal:9000", "http://evil.example:9000"), "audit.internal", 9000), false);
  assert.equal(checkRequestOrigin(request("localhost", "http://localhost"), "127.0.0.1", 80), true);
  assert.equal(checkRequestOrigin(request("localhost:80", "http://localhost/"), "127.0.0.1", 80), false);
});

test("stream rejects immediately at byte limit without waiting for end or destroying socket", async () => {
  const req = new PassThrough();
  req.headers = { "content-type": "application/json" };
  const result = readJson(req);
  req.write(Buffer.alloc(10_000, 32));
  req.write(Buffer.from("x"));
  await assert.rejects(result, (error) => error.status === 413);
  assert.equal(req.destroyed, false);
  assert.equal(req.isPaused(), true);
  assert.equal(req.listenerCount("data"), 0);
  req.destroy();
});

test("lying Content-Length cannot bypass the streamed limit", async () => {
  const req = new PassThrough();
  req.headers = { "content-type": "application/json", "content-length": "1" };
  const result = readJson(req);
  req.end(Buffer.alloc(10_001));
  await assert.rejects(result, (error) => error.status === 413);
});

test("interrupted body is rejected and listeners removed", async () => {
  const req = new PassThrough();
  req.headers = { "content-type": "application/json" };
  const result = readJson(req);
  req.emit("aborted");
  await assert.rejects(result, (error) => error.status === 400);
  assert.equal(req.listenerCount("data"), 0);
  req.emit("error", new Error("late socket reset"));
  req.destroy();
});
