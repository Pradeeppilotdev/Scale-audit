import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Raw SQL with no LIMIT: returns the whole table.
export async function allUsers() {
  return prisma.$queryRaw`SELECT * FROM users`;
}

// Raw SQL with a LIMIT: bounded.
export async function someUsers() {
  return prisma.$queryRaw`SELECT * FROM users LIMIT 50`;
}
