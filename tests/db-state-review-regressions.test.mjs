import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectUnboundedReads } from "../dist/detectors/unbounded.js";
import { detectInProcessState } from "../dist/detectors/inProcessState.js";
import { detectMissingIndexes } from "../dist/detectors/missingIndex.js";
import { parseModels } from "../dist/prisma.js";

async function audit(source, detector, files = {}) {
  const root = await mkdtemp(join(tmpdir(), "scale-db-state-review-"));
  try {
    for (const [file, content] of Object.entries({ "server.ts": source, ...files })) await writeFile(join(root, file), content);
    return await detector(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

for (const [options, expected] of [
  ["{ text: 'SELECT * FROM users LIMIT 10', ...options }", "unknown"],
  ["{ ...options, text: 'SELECT * FROM users LIMIT 10' }", "bounded"],
  ["{ text: 'SELECT * FROM users LIMIT 10', [key]: value }", "unknown"],
  ["{ text: 'SELECT * FROM users LIMIT 10', text }", "unknown"],
  ["{ text: 'SELECT * FROM users LIMIT 10', get text() { return sql; } }", "unknown"],
  ["{ text: 'SELECT * FROM users LIMIT 10', text: 'SELECT * FROM users' }", "unbounded"],
  ["{ text: 'SELECT * FROM users', text: 'SELECT * FROM users LIMIT 10' }", "bounded"],
  ["{ query: gql`{ users { id } }`, ...options }", "bounded"],
]) {
  test(`raw SQL options respect final effective text in ${options}`, async () => {
    const findings = await audit(`export function GET() { return client.query(${options}); }`, detectUnboundedReads);
    if (expected === "bounded") assert.deepEqual(findings, []);
    else {
      assert.equal(findings.length, 1);
      assert.equal(findings[0].id, expected === "unknown" ? "unbounded-read" : "unbounded-raw-query");
      assert.equal(findings[0].confidence, expected === "unknown" ? "low" : "high");
    }
  });
}
for (const wrapper of [value => `(${value})`, value => `(${value} as string)`, value => `(${value} satisfies string)`, value => `(${value}!)`]) {
  for (const bounded of [false, true]) test(`erased wrappers preserve ${bounded ? "bounded" : "unbounded"} raw SQL: ${wrapper("sql")}`, async () => {
    const sql = JSON.stringify(`SELECT * FROM users${bounded ? " LIMIT 10" : ""}`);
    assert.equal((await audit(`export function GET() { return prisma.$queryRawUnsafe(${wrapper(sql)}); }`, detectUnboundedReads)).length, bounded ? 0 : 1);
  });
}
for (const wrapper of [value => `(${value} as Options)`, value => `(${value} satisfies Options)`]) {
  test(`typed ORM options retain a visible pagination cap: ${wrapper("options")}`, async () => {
    assert.deepEqual(await audit(`prisma.user.findMany(${wrapper("{ take: 10 }")});`, detectUnboundedReads), []);
    assert.equal((await audit(`prisma.user.findMany(${wrapper("{ where: { active: true } }")});`, detectUnboundedReads)).length, 1);
  });
}

for (const [name, annotation, indexed] of [
  ["ordinary index", "@@index([email])", true],
  ["sorted index", "@@index([email(sort: Desc)])", true],
  ["multiline index", "@@index([\n email(sort: Desc),\n id\n])", true],
  ["composite primary key", "@@id([email, id])", true],
  ["trailing composite key", "@@id([id, email])", false],
  ["commented block index", "/*\n@@index([email])\n*/", false],
  ["commented line index", "// @@index([email])", false],
]) {
  test(`Prisma ${name} has the correct leading index field`, async () => {
    const schema = `model User {\n id Int\n email String\n ${annotation}\n  }`;
    const model = parseModels(schema).get("user");
    assert.ok(model); assert.equal(model.indexed.has("email"), indexed);
    const findings = await audit("prisma.user.findMany({ where: { email: input } });", detectMissingIndexes, { "schema.prisma": schema });
    assert.equal(findings.length, indexed ? 0 : 1);
  });
}
for (const declaration of ["email String // @unique", 'email String @default("@unique")', 'email String @default("// @id")']) {
  test(`Prisma text in comments/defaults does not invent an index: ${declaration}`, async () => {
    const schema = `model User {\n id Int @id\n ${declaration}\n}`;
    assert.equal(parseModels(schema).get("user").indexed.has("email"), false);
    assert.equal((await audit("prisma.user.findMany({ where: { email: input } });", detectMissingIndexes, { "schema.prisma": schema })).length, 1);
  });
}
for (const [options, expected] of [
  ["({ where: { email: input } } satisfies Options)", 1],
  ["{ where: ({ email: input } satisfies Filter) }", 1],
  ["{ where: { email: input }, ...options }", 0],
  ["{ ...options, where: { email: input } }", 1],
  ["{ where: { email: input }, where: { id: 1 } }", 0],
  ["{ where: { id: 1 }, where: { email: input } }", 1],
  ["{ where: { email: input }, get where() { return { id: 1 }; } }", 0],
  ["{ get where() { return { id: 1 }; }, where: { email: input } }", 1],
]) {
  test(`missing-index checks the final visible filter in ${options}`, async () => {
    const schema = "model User {\n id Int @id\n email String\n}";
    assert.equal((await audit(`prisma.user.findMany(${options});`, detectMissingIndexes, { "schema.prisma": schema })).length, expected);
  });
}

for (const [source, expected] of [
  ["import session from 'express-session'; session({});", 1],
  ["import make from 'express-session'; const alias = make; alias({});", 1],
  ["import session from 'express-session'; let run = session; run = () => ({}); run({});", 0],
  ["import session from 'express-session'; let run = () => ({}); run = session; run({});", 1],
  ["import session from 'express-session'; let run = session; const captured = run; run = () => ({}); captured({});", 1],
  ["import session from 'express-session'; let run = session; if (enabled) run = () => ({}); run({});", 0],
  ["import * as factory from 'express-rate-limit'; let run = factory; run = { rateLimit() {} }; run.rateLimit({});", 0],
  ["import * as factory from 'express-rate-limit'; let run = factory; const captured = run.rateLimit; run = { rateLimit() {} }; captured({});", 1],
  ["const make = require('express-session'); make({});", 1],
  ["require('express-session')({});", 1],
  ["import * as session from 'express-session'; session.default({});", 1],
  ["import session from 'express-session'; function helper(session) { session({}); }", 0],
  ["function session(options) { return options; } session({});", 0],
  ["const auth = { session() {} }; auth.session({});", 0],
  ["import session from 'cookie-session'; session({ keys: ['key'] });", 0],
  ["import { rateLimit as make } from 'express-rate-limit'; make({});", 1],
  ["import * as limits from 'express-rate-limit'; limits.rateLimit({});", 1],
  ["const { rateLimit: make } = require('express-rate-limit'); make({});", 1],
  ["import { ipKeyGenerator as rateLimit } from 'express-rate-limit'; rateLimit(req.ip);", 0],
  ["import * as limits from 'express-rate-limit'; limits.ipKeyGenerator(req.ip);", 0],
  ["const { ipKeyGenerator: rateLimit } = require('express-rate-limit'); rateLimit(req.ip);", 0],
  ["import { Cookie as session } from 'express-session'; session({});", 0],
  ["import * as session from 'express-session'; session.Cookie({});", 0],
  ["import { normalizeIP as rateLimit } from '@fastify/rate-limit'; rateLimit(req.ip);", 0],
  ["import rateLimit from 'express-rate-limit'; function helper(rateLimit) { rateLimit({}); }", 0],
]) {
  test(`middleware identity is resolved at its call site: ${source}`, async () => {
    const findings = await audit(source, detectInProcessState);
    assert.equal(findings.filter(finding => ["in-process-session", "in-memory-rate-limit"].includes(finding.id)).length, expected);
  });
}
for (const [options, severity] of [
  ["{ store: undefined }", "high"], ["{ store: null }", "high"], ["{ store: false }", "high"],
  ["({ store: undefined } satisfies Options)", "high"],
  ["{ store: redis, ...options }", "low"], ["{ ...options, store: redis }", null],
  ["{ store: redis, store: undefined }", "high"], ["{ store: undefined, store: redis }", null],
  ["{ get store() { return chooseStore(); } }", "low"],
]) {
  test(`shared-store evidence follows option overrides: ${options}`, async () => {
    const findings = await audit(`import session from 'express-session'; session(${options});`, detectInProcessState);
    assert.equal(findings.length, severity ? 1 : 0);
    if (severity) assert.equal(findings[0].severity, severity);
  });
}
for (const [source, expected] of [
  ["const cache = new Map(); export function write() { cache.set('x', 1); }", 1],
  ["let cache = new Map(); export function write() { cache.set('x', 1); }", 1],
  ["let cache = new Map(); cache = { set() {} }; export function write() { cache.set('x', 1); }", 0],
  ["let cache = new Map(); if (enabled) cache = { set() {} }; export function write() { cache.set('x', 1); }", 0],
  ["const cache = new Map(); export function write(cache) { cache.set('x', 1); }", 0],
  ["const cache = new Map(); export function write() { const cache = new Map(); cache.set('x', 1); }", 0],
  ["const cache = new Map(); cache.set('x', 1);", 0],
  ["class Map { set() {} } const cache = new Map(); export function write() { cache.set('x', 1); }", 0],
  ["const cache = (() => { new Map(); return {}; })(); export function write() { cache.set('x', 1); }", 0],
]) {
  test(`runtime collection writes preserve declaration identity: ${source}`, async () => {
    assert.equal((await audit(source, detectInProcessState)).filter(finding => finding.id === "in-process-state").length, expected);
  });
}

for (const [source, expected] of [
  ["import { Server as SocketServer } from 'socket.io'; new SocketServer();", 1],
  ["import makeSockets from 'socket.io'; makeSockets();", 1],
  ["import * as sockets from 'socket.io'; new sockets.Server();", 1],
  ["const makeSockets = require('socket.io'); makeSockets();", 1],
  ["require('socket.io')();", 1],
  ["new (require('socket.io').Server)();", 1],
  ["const { Server: SocketServer } = require('socket.io'); new SocketServer();", 1],
  ["import { Server } from 'socket.io'; const Alias = Server; new Alias();", 1],
  ["import { Server } from 'socket.io'; let Alias = Server; Alias = class {}; new Alias();", 0],
  ["import { Server } from 'socket.io'; let Alias = class {}; Alias = Server; new Alias();", 1],
  ["import { Server } from 'socket.io'; let Alias = Server; const Captured = Alias; Alias = class {}; new Captured();", 1],
  ["import { Server } from 'socket.io'; let Alias = Server; if (enabled) Alias = class {}; new Alias();", 0],
  ["import * as sockets from 'socket.io'; let alias = sockets; alias = { Server: class {} }; new alias.Server();", 0],
  ["import { Server } from 'socket.io'; function build(Server) { return new Server(); }", 0],
  ["import { Server as SocketServer } from 'socket.io'; class Server {} new Server();", 0],
  ["import 'socket.io'; function io() {} io();", 0],
  ["import { Namespace as Server } from 'socket.io'; new Server();", 0],
  ["function build(require) { const io = require('socket.io'); io(); }", 0],
  ["import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const io = require('socket.io'); io();", 1],
]) {
  test(`Socket.IO construction uses current import identity: ${source}`, async () => {
    assert.equal((await audit(source, detectInProcessState)).filter(finding => finding.id === "in-memory-websocket").length, expected);
  });
}
test("Socket.IO identity follows a named re-export", async () => {
  const findings = await audit("import { SocketServer } from './sockets'; new SocketServer();", detectInProcessState,
    { "sockets.ts": "export { Server as SocketServer } from 'socket.io';" });
  assert.equal(findings.filter(finding => finding.id === "in-memory-websocket").length, 1);
});
for (const adapter of ["@socket.io/redis-adapter", "socket.io-redis"]) {
  test(`the existing Socket.IO adapter dependency exemption remains unchanged for ${adapter}`, async () => {
    const findings = await audit("import { Server as SocketServer } from 'socket.io'; new SocketServer();", detectInProcessState,
      { "package.json": JSON.stringify({ dependencies: { [adapter]: "*" } }) });
    assert.deepEqual(findings, []);
  });
}
