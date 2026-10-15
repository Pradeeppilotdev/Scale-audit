const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function unboundedDefault() {
  return prisma.user.findMany();
}

async function unboundedWhere() {
  return prisma.user.findMany({ where: { active: true } });
}

async function boundedWhere() {
  return prisma.user.findMany({ where: { active: true }, take: 25 });
}

async function uniqueOne() {
  return prisma.user.findFirst({ where: { id: 1 } });
}

const User = {
  find: () => ({ limit: (n) => ({ n }) }),
};

function chainedLimit() {
  return User.find().limit(10);
}

module.exports = { unboundedDefault, unboundedWhere, boundedWhere, uniqueOne, chainedLimit };
