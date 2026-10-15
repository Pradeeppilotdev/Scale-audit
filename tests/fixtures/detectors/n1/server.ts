import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function listUsers() {
  const users = await prisma.user.findMany({ take: 10 });
  const out: unknown[] = [];
  for (const u of users) {
    const orders = await prisma.order.findMany({ where: { userId: u.id }, take: 5 });
    out.push(orders);
  }
  return out;
}
