import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";

// Correct: one client for the whole process.
const prisma = new PrismaClient();

// Correct: a dependency-injection container constructs this service once.
export class ReadService {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({ connectionString: "postgres://localhost/db" });
  }

  query() {
    return this.pool.query("SELECT 1");
  }
}

// Wrong: a new connection pool per request.
export async function handler() {
  const client = new PrismaClient();
  return client.user.findMany();
}

export async function alsoHandler() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool.query("SELECT 1");
}
