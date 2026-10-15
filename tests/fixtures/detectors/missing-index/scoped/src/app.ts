import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// This project's schema marks clerkId @unique, so this must NOT be flagged
// even though another schema in the repo has a User model without it.
export async function byClerkId() {
  return prisma.user.findMany({ where: { clerkId: "user_123" } });
}
