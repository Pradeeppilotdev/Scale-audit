import express from "express";
import session from "express-session";
import rateLimit from "express-rate-limit";
import { Server } from "socket.io";

const app = express();
const myStore = {} as any;

app.use(session({ secret: "x" } as any));

const limiter = rateLimit({ windowMs: 1000, max: 10 });
const limiterWithStore = rateLimit({ windowMs: 1000, max: 10, store: myStore });

const cache = new Map<string, string>();

const io = new Server();

export { limiter, limiterWithStore, cache, io };
