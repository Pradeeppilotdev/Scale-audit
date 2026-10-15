import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function byEmail() {
  return prisma.user.findMany({ where: { email: "a@b.com" } });
}

export async function byName() {
  return prisma.user.findMany({ where: { name: "a" } });
}
