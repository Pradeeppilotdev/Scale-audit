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

// Query object passed as a variable: can't confirm pagination, should be low confidence only.
async function variableQuery(q) {
  return prisma.user.findMany(q);
}

const User = {
  find: () => ({ limit: (n) => ({ n }) }),
};

function chainedLimit() {
  return User.find().limit(10);
}

// Mongoose options object in the 3rd argument: bounded.
function mongooseOptions() {
  return User.find({ active: true }, null, { limit: 5 });
}

// Plain array helper on a capitalized receiver: must not be treated as a DB read.
function localLookup(users) {
  return Users.find((u) => u.id === 1);
}

module.exports = {
  unboundedDefault,
  unboundedWhere,
  boundedWhere,
  uniqueOne,
  variableQuery,
  chainedLimit,
  mongooseOptions,
  localLookup,
};
