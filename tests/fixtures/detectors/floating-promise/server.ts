import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// A write that is never awaited: the write may never complete.
export function createUser() {
  prisma.user.create({ data: { email: "a@b.com" } });
}

// A rejection with no catch handler: it becomes an unhandled rejection.
export function sendEmail() {
  fetch("https://example.com").then((res) => res.json());
}

// Correct: awaited.
export async function createUserAwaited() {
  return prisma.user.create({ data: { email: "c@d.com" } });
}

// Correct: explicit catch.
export function createUserHandled() {
  prisma.user.create({ data: { email: "e@f.com" } }).catch(() => {});
}

// Correct: the promise is returned, so the caller awaits it.
export function createUserReturned() {
  return prisma.user.create({ data: { email: "g@h.com" } });
}
