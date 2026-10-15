const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
async function main() {
  const users = await prisma.user.findMany();
  const one = await prisma.user.findMany({ where: { id: 1 } });
  return users;
}
