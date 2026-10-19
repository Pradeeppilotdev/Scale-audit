const { PrismaClient } = require("@prisma/client");
const mongoose = require("mongoose");
const prisma = new PrismaClient();
const Post = mongoose.model("Post", new mongoose.Schema({ title: String }));

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

// Aggregates are bounded by construction and must never be reported.
async function aggregateCall() {
  return prisma.user.aggregate({ _count: true });
}

async function countCall() {
  return prisma.user.count();
}

// Query object passed as a variable: can't confirm pagination, should be low confidence only.
async function variableQuery(q) {
  return prisma.user.findMany(q);
}

// A plain object with a `find` method is not a database model.
const User = {
  find: () => ({ limit: (n) => ({ n }) }),
};

function chainedLimit() {
  return User.find().limit(10);
}

// Mongoose options object in the 3rd argument: bounded.
function mongooseOptions() {
  return Post.find({ active: true }, null, { limit: 5 });
}

// A service class is business logic, not a data-access layer.
class UserService {
  find(id) {
    return { id };
  }
  findMany() {
    return [];
  }
}

function serviceCall() {
  return new UserService().find(1);
}

// Plain array helper on a capitalized receiver: must not be treated as a DB read.
function localLookup(users) {
  return Users.find((u) => u.id === 1);
}

const client = { query: async (q) => q };

// Apollo/GraphQL client: NOT a DB read.
function graphqlQuery() {
  return client.query({ query: "query { feed { id } }" });
}

// node-postgres style raw SQL: IS a DB read.
function rawSqlQuery() {
  return client.query("SELECT * FROM users");
}

module.exports = {
  unboundedDefault,
  unboundedWhere,
  boundedWhere,
  uniqueOne,
  aggregateCall,
  countCall,
  variableQuery,
  chainedLimit,
  mongooseOptions,
  serviceCall,
  localLookup,
  graphqlQuery,
  rawSqlQuery,
};
