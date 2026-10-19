import ts from "typescript";

/**
 * Per-file facts that make detection precise.
 *
 * The naive version of this problem is "a capitalised receiver means a model"
 * (`User.find()`), which is wrong for the extremely common `UserService.find()`.
 * We only treat a capitalised receiver as a database model when there is
 * evidence: it is bound to a model factory, imported from an entity/model path,
 * or present in a Prisma schema.
 */
export interface FileContext {
  /** Local binding names for each imported module specifier. */
  imports: Map<string, Set<string>>;
  /** Model-like local names (mongoose.model, sequelize.define, entity imports). */
  knownModels: Set<string>;
  /** Local names imported from a session package (express-session, ...). */
  sessionBindings: Set<string>;
  /** Local names imported from a rate-limit package. */
  rateLimitBindings: Set<string>;
  /** True when the file imports an ORM/driver that makes model calls plausible. */
  hasOrmImport: boolean;
  /** Model names discovered in Prisma schemas (lower-cased). */
  schemaModels: Set<string>;
}

const ORM_MODULES = new Set([
  "@prisma/client",
  "prisma",
  "@prisma/adapter-pg",
  "@prisma/adapter-neon",
  "mongoose",
  "sequelize",
  "typeorm",
  "@mikro-orm/core",
  "@mikro-orm/nestjs",
  "@mikro-orm/knex",
  "drizzle-orm",
  "objection",
  "kysely",
  "postgres",
  "pg",
  "mysql2",
  "better-sqlite3",
  "tedious",
  "@supabase/supabase-js",
]);

const SESSION_MODULES = new Set(["express-session", "cookie-session", "fastify-session", "@fastify/session"]);
const RATE_LIMIT_MODULES = new Set([
  "express-rate-limit",
  "rate-limiter-flexible",
  "fastify-rate-limit",
  "@fastify/rate-limit",
  "koa-ratelimit",
]);

/** Import specifiers that look like a model/entity/repository module. */
const MODEL_PATH = /(^|\/)(entit|model|schema|repositor|collection)/i;
const MODEL_FILE = /\.(entity|model|schema|repository)$/i;

export function emptyContext(schemaModels: Set<string> = new Set()): FileContext {
  return {
    imports: new Map(),
    knownModels: new Set(),
    sessionBindings: new Set(),
    rateLimitBindings: new Set(),
    hasOrmImport: false,
    schemaModels,
  };
}

/** Build the per-file context from its AST. Cheap: one shallow walk. */
export function buildContext(sf: ts.SourceFile, schemaModels: Set<string> = new Set()): FileContext {
  const ctx = emptyContext(schemaModels);
  collectImports(sf, ctx);
  collectEntityImports(sf, ctx);
  collectModelBindings(sf, ctx);
  return ctx;
}

function collectImports(sf: ts.SourceFile, ctx: FileContext): void {
  const add = (spec: string, local: string) => {
    let set = ctx.imports.get(spec);
    if (!set) {
      set = new Set();
      ctx.imports.set(spec, set);
    }
    set.add(local);
  };

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const spec = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      if (clause?.name) add(spec, clause.name.text);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          add(spec, clause.namedBindings.name.text);
        } else {
          for (const el of clause.namedBindings.elements) {
            add(spec, (el.propertyName ?? el.name).text);
            add(spec, el.name.text);
          }
        }
      }
      if (ORM_MODULES.has(spec)) ctx.hasOrmImport = true;
    }
  }

  // `const x = require("m")` / `const { a } = require("m")`
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
      const call = node.initializer;
      if (ts.isIdentifier(call.expression) && call.expression.text === "require" && call.arguments[0] && ts.isStringLiteral(call.arguments[0])) {
        const spec = call.arguments[0].text;
        if (ts.isIdentifier(node.name)) add(spec, node.name.text);
        else if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            if (!ts.isBindingElement(el)) continue;
            if (el.propertyName && ts.isIdentifier(el.propertyName)) add(spec, el.propertyName.text);
            if (ts.isIdentifier(el.name)) add(spec, el.name.text);
          }
        }
        if (ORM_MODULES.has(spec)) ctx.hasOrmImport = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Session / rate-limit packages may also be pulled in via require().
  for (const [spec, names] of ctx.imports) {
    if (SESSION_MODULES.has(spec)) for (const n of names) ctx.sessionBindings.add(n);
    if (RATE_LIMIT_MODULES.has(spec)) for (const n of names) ctx.rateLimitBindings.add(n);
  }
}

function collectModelBindings(sf: ts.SourceFile, ctx: FileContext): void {
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const init = node.initializer;
      if (ts.isCallExpression(init)) {
        if (ts.isPropertyAccessExpression(init.expression)) {
          const receiver = init.expression.expression.getText();
          const method = init.expression.name.getText();
          if ((receiver === "mongoose" || receiver === "sequelize") && (method === "model" || method === "define")) {
            ctx.knownModels.add(node.name.text);
          }
        } else if (ts.isIdentifier(init.expression)) {
          // `const User = model("User", schema)` with `model` imported from mongoose.
          for (const [spec, names] of ctx.imports) {
            if (!ORM_MODULES.has(spec)) continue;
            if (names.has(init.expression.text)) ctx.knownModels.add(node.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/**
 * `import { User } from "./models/user"` -> User is a model.
 *
 * Runs once over the top-level statements; doing this inside the AST walk
 * made context building quadratic in the number of statements.
 */
function collectEntityImports(sf: ts.SourceFile, ctx: FileContext): void {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    if (!MODEL_PATH.test(spec) && !MODEL_FILE.test(spec)) continue;
    const clause = stmt.importClause;
    if (clause?.name) ctx.knownModels.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) ctx.knownModels.add(el.name.text);
    }
  }
}

/** Last identifier segment of a dotted expression, e.g. "prisma.user" -> "user". */
export function lastSegment(text: string): string | null {
  const parts = text.split(".");
  const last = parts[parts.length - 1];
  if (!last || !/^[A-Za-z_$][\w$]*$/.test(last)) return null;
  return last;
}
