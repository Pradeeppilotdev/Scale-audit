import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { detectPerRequestClients } from "../dist/detectors/perRequestClient.js";
import { staticExpression } from "../dist/staticValues.js";

const containers = [
  { name: "TSyringe", imports: "import{container,Lifecycle}from'tsyringe';", shared: "Lifecycle.Singleton", fresh: "Lifecycle.Transient",
    registration: value => `container.register('db',{useFactory:()=>new PrismaClient()},{lifecycle:${value}});`,
    resolve: "return container.resolve('db');" },
  { name: "Awilix", imports: "import{createContainer,asFunction,Lifetime}from'awilix';const container=createContainer();", shared: "Lifetime.SINGLETON", fresh: "Lifetime.TRANSIENT",
    registration: value => `container.register({db:asFunction(()=>new PrismaClient(),{lifetime:${value}})});`,
    resolve: "return container.resolve('db');" },
  { name: "Nest", imports: "import{Injectable,Scope}from'@nestjs/common';", shared: "Scope.DEFAULT", fresh: "Scope.REQUEST",
    registration: value => `@Injectable({scope:${value}})class Db{db=new PrismaClient();}`,
    resolve: "return {};" },
  { name: "Inversify", imports: "import{Container}from'inversify';", shared: "'Singleton'", fresh: "'Transient'",
    registration: value => `const container=new Container({defaultScope:${value}});container.bind('db').toDynamicValue(()=>new PrismaClient());`,
    resolve: "return container.get('db');" },
];

async function withSource(source, run = detectPerRequestClients) {
  const root = await mkdtemp(join(tmpdir(), "scale-di-scope-write-"));
  try {
    await writeFile(join(root, "route.ts"), source);
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const api of containers) {
  const scenarios = [
    ["updated to fresh", `let scope=${api.shared};scope=${api.fresh};`, "scope", "", "per-request-client"],
    ["updated to shared", `let scope=${api.fresh};scope=${api.shared};`, "scope", "", undefined],
    ["captured shared before update", `let scope=${api.shared};const captured=scope;scope=${api.fresh};`, "captured", "", undefined],
    ["captured fresh before update", `let scope=${api.fresh};const captured=scope;scope=${api.shared};`, "captured", "", "per-request-client"],
    ["captured fresh after update", `let scope=${api.shared};scope=${api.fresh};const captured=scope;`, "captured", "", "per-request-client"],
    ["later write cannot change captured metadata", `let scope=${api.shared};`, "scope", `scope=${api.fresh};`, undefined],
    ["conditional write stays unknown", `let scope=${api.shared};if(flag)scope=${api.fresh};`, "scope", "", "unknown-provider-lifetime"],
    ["nested write stays unknown", `let scope=${api.shared};function update(){scope=${api.fresh};}update();`, "scope", "", "unknown-provider-lifetime"],
    ["immutable alias stays shared", `const scope=${api.shared};const captured=scope;`, "captured", "", undefined],
  ];
  for (const [name, setup, value, after, expected] of scenarios) {
    test(`${api.name} scope ${name}`, async () => {
      const source = `import{PrismaClient}from'@prisma/client';${api.imports}${setup}${api.registration(value)}${after}export function GET(){${api.resolve}}`;
      const findings = await withSource(source);
      assert.deepEqual(findings.map(finding => finding.id), expected ? [expected] : []);
      if (expected) assert.equal(findings[0].severity, expected === "unknown-provider-lifetime" ? "info" : "high");
    });
  }
}

test("repeated DI metadata reads reuse validated assignment history within the work limit", async () => {
  const entries = Array.from({ length: 250 }, (_, index) => `container.register('db${index}',{useFactory:()=>new PrismaClient()},{lifecycle:scope});`).join("\n");
  const requests = Array.from({ length: 250 }, (_, index) => `container.resolve('db${index}');`).join("\n");
  const source = `import{PrismaClient}from'@prisma/client';import{container,Lifecycle}from'tsyringe';
    let scope=Lifecycle.Transient;${"scope=Lifecycle.Singleton;".repeat(250)}
    ${entries}export function GET(){${requests}}`;
  const findings = await withSource(source);
  assert.deepEqual(findings, []);
});

test("wide mutable metadata history is validated once across distinct and repeated reads", () => {
  const source = `let scope='Transient';${"scope='Singleton';".repeat(1000)}
    ${Array.from({ length: 1000 }, (_, index) => `const capture${index}=scope;`).join("\n")}`;
  const sf = ts.createSourceFile("scope-history.ts", source, ts.ScriptTarget.Latest, true);
  for (let repeat = 0; repeat < 4; repeat++) {
    for (const statement of sf.statements.slice(1001)) {
      const value = staticExpression(statement.declarationList.declarations[0].initializer);
      assert.ok(value && ts.isStringLiteralLike(value));
      assert.equal(value.text, "Singleton");
    }
  }
});
