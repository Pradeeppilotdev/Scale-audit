import express from "express";
import session from "express-session";
import rateLimit from "express-rate-limit";
import { Server } from "socket.io";

const app = express();
const myStore = {} as any;

app.use(session({ secret: "x" } as any));

const limiter = rateLimit({ windowMs: 1000, max: 10 });
const limiterWithStore = rateLimit({ windowMs: 1000, max: 10, store: myStore });

// Runtime state: mutated while serving requests, so it is reported.
const cache = new Map<string, string>();

export function remember(key: string, value: string) {
  cache.set(key, value);
}

// A module-level collection that is only filled at import time is a constant
// lookup table, not runtime state, so it must NOT be reported.
const staticCache = new Set<string>(["a", "b"]);

const io = new Server();

export { limiter, limiterWithStore, cache, staticCache, io };
