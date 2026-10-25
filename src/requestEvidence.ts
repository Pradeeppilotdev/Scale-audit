import ts from "typescript";
import { importedBinding } from "./bindings.js";
import { staticExpression, staticProperty } from "./staticValues.js";
import type { Workspace } from "./workspace.js";
import { AnalysisBudget, projectWorkLimit } from "./analysisBudget.js";

type FunctionNode = ts.SignatureDeclaration & ts.Node;
function enclosingFunction(node: ts.Node): FunctionNode | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) if (ts.isFunctionLike(parent)) return parent;
  return undefined;
}

/** Function identities, rather than arbitrary methods named get() or outer lexical scopes. */
const evidenceCache = new WeakMap<Workspace, (node: ts.Node) => boolean>();
export function requestEvidence(workspace: Workspace): (node: ts.Node) => boolean {
  const cached = evidenceCache.get(workspace); if (cached) return cached;
  const roots = new Set<ts.Node>();
  const edges = new Map<ts.Node, Set<ts.Node>>();
  const budget = new AnalysisBudget("Request reachability", projectWorkLimit(workspace.units.map(unit => unit.sf)));
  const httpReceiver = (node: ts.Node): boolean => {
    const value = staticExpression(node);
    if (value && (ts.isCallExpression(value) || ts.isNewExpression(value))) {
      const binding = importedBinding(value.expression);
      if (binding && /^(express|fastify|koa|@koa\/router|node:https?|https?)$/.test(binding.module)) return true;
    }
    // An unknown conventional receiver is evidence; a known local object is not.
    return ts.isIdentifier(node) && /^(app|router|server)$/.test(node.text) && (!value || value === node);
  };
  const edge = (caller: ts.Node, callee: ts.Node) => { const set = edges.get(caller) ?? new Set(); set.add(callee); edges.set(caller, set); };
  for (const { sf } of workspace.units) {
    const visit = (node: ts.Node) => {
      if (ts.isFunctionLike(node)) {
        const exported = ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
        const variable = ts.isVariableDeclaration(node.parent) && node.parent.initializer === node ? node.parent : undefined;
        const variableStatement = variable?.parent.parent;
        const exportedVariable = variableStatement && ts.isVariableStatement(variableStatement) && ts.getModifiers(variableStatement)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
        const entryName = node.name?.getText() ?? variable?.name.getText();
        if ((exported || exportedVariable) && entryName && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(entryName)) roots.add(node);
        if (ts.canHaveDecorators(node)) for (const decorator of ts.getDecorators(node) ?? []) {
          if (!ts.isCallExpression(decorator.expression)) continue;
          const binding = importedBinding(decorator.expression.expression);
          if (binding?.module === "@nestjs/common" && /^(Get|Post|Put|Patch|Delete|Head|Options|All)$/.test(binding.name)) roots.add(node);
        }
        if (node.parameters.length >= 2 && /^(req|request)$/.test(node.parameters[0].name.getText()) && /^(res|response|reply)$/.test(node.parameters[1].name.getText())) roots.add(node);
      }
      if (ts.isCallExpression(node)) {
        const callee = staticExpression(node.expression);
        const caller = enclosingFunction(node);
        if (caller && callee && ts.isFunctionLike(callee)) edge(caller, callee);
        const expression = node.expression;
        const binding = importedBinding(expression);
        const registration = ts.isPropertyAccessExpression(expression) && /^(get|post|put|patch|delete|use|all|head|options)$/.test(expression.name.text) && httpReceiver(expression.expression);
        const server = binding && /^(node:)?https?$/.test(binding.module) && binding.name === "createServer";
        if (ts.isPropertyAccessExpression(expression) && expression.name.text === "route" && httpReceiver(expression.expression)) {
          const handler = staticExpression(staticProperty(node.arguments[0], "handler", budget));
          if (handler && ts.isFunctionLike(handler)) roots.add(handler);
        }
        // Literal/locally visible arrays execute their standard iteration callbacks.
        if (caller && ts.isPropertyAccessExpression(expression) && /^(map|forEach|filter|flatMap|some|every|reduce)$/.test(expression.name.text)) {
          const receiver = staticExpression(expression.expression);
          if (receiver && ts.isArrayLiteralExpression(receiver)) for (const argument of node.arguments) {
            const fn = staticExpression(argument); if (fn && ts.isFunctionLike(fn)) edge(caller, fn);
          }
        }
        if (registration || server) for (const argument of node.arguments) {
          const fn = staticExpression(argument);
          if (fn && ts.isFunctionLike(fn)) roots.add(fn);
        }
      }
      ts.forEachChild(node, visit);
    }; visit(sf);
  }
  const pending = [...roots];
  while (pending.length) {
    const current = pending.pop()!;
    for (const callee of edges.get(current) ?? []) { budget.take(); if (!roots.has(callee)) { roots.add(callee); pending.push(callee); } }
  }
  const evidence = (node: ts.Node) => { const owner = enclosingFunction(node); return !!owner && roots.has(owner); };
  evidenceCache.set(workspace, evidence); return evidence;
}
