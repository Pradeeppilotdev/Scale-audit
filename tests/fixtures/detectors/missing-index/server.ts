import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function byEmail() {
  return prisma.user.findMany({ where: { email: "a@b.com" } });
}

export async function byName() {
  return prisma.user.findMany({ where: { name: "a" } });
}

// Logical operators must not be treated as columns.
export async function byEither() {
  return prisma.user.findMany({ where: { OR: [{ email: "a@b.com" }, { name: "a" }] } });
}

// Nested relation filters must not be treated as columns.
export async function withRelation() {
  return prisma.user.findMany({ where: { profile: { is: { bio: "x" } } } });
}
