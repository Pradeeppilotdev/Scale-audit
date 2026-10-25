import ts from "typescript";
import { staticExpression } from "./staticValues.js";
import { AnalysisBudget } from "./analysisBudget.js";
import type { Workspace } from "./workspace.js";
import type { ProviderLifetime } from "./lifetimes.js";
import { requestEvidence } from "./requestEvidence.js";

/** Calls made while a factory runs or a class instance is constructed. Deferred
 * callbacks and ordinary methods are scanned only when their invocation is known. */
export function constructionCalls(owner: ts.Node, budget: AnalysisBudget): ts.CallExpression[] {
  const pending: ts.Node[] = [];
  if (ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) {
    for (const member of owner.members) {
      if (ts.isConstructorDeclaration(member) && member.body) pending.push(member.body);
      if (ts.isPropertyDeclaration(member) && member.initializer && !ts.getModifiers(member)?.some(m => m.kind === ts.SyntaxKind.StaticKeyword)) pending.push(member.initializer);
    }
  } else if (ts.isFunctionLike(owner) && "body" in owner && owner.body) pending.push(owner.body as ts.Node);
  const calls: ts.CallExpression[] = [];
  while (pending.length) {
    budget.take(); const node = pending.pop()!;
    if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) continue;
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, child => { pending.push(child); });
  }
  return calls;
}

/** Propagate execution lifetimes through visible local calls. Mixed request and
 * cached callers retain the riskier lifetime; no target function is executed. */
export function executionLifetimes(workspace: Workspace, seeds: Map<ts.Node, ProviderLifetime>): Map<ts.Node, ProviderLifetime> {
  const result = new Map(seeds), budget = new AnalysisBudget("Factory call graph", 200_000);
  const request = requestEvidence(workspace);
  const edges = new Map<ts.Node, Set<ts.Node>>();
  const rank = { singleton: 0, transient: 1, unknown: 2, request: 3 };
  const pending: ts.Node[] = [];
  const merge = (node: ts.Node, lifetime: ProviderLifetime) => {
    const kind = lifetime.requestConsumer ? "request" : lifetime.kind;
    const old = result.get(node);
    if (!old || rank[kind] > rank[old.kind]) { result.set(node, { kind }); pending.push(node); }
  };
  const targets = (node: ts.Node) => {
    const found = new Set<ts.Node>();
    for (const call of constructionCalls(node, budget)) {
      const target = staticExpression(call.expression, new Set(), budget);
      if (target && ts.isFunctionLike(target)) found.add(target);
    }
    return found;
  };
  for (const [node, lifetime] of seeds) {
    if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      edges.set(node, targets(node));
      for (const target of edges.get(node)!) merge(target, lifetime);
    }
  }
  for (const { sf } of workspace.units) {
    const nodes: ts.Node[] = [sf];
    while (nodes.length) {
      budget.take(); const node = nodes.pop()!;
      if (ts.isCallExpression(node)) {
        const target = staticExpression(node.expression, new Set(), budget);
        if (target && ts.isFunctionLike(target)) {
          if (request(node)) merge(target, { kind: "request" });
          else {
            let parent = node.parent;
            while (parent && !ts.isFunctionLike(parent) && !ts.isClassDeclaration(parent) && !ts.isClassExpression(parent)) parent = parent.parent;
            if (!parent) merge(target, { kind: "singleton" });
          }
        }
      }
      ts.forEachChild(node, child => { nodes.push(child); });
    }
  }
  while (pending.length) {
    budget.take(); const node = pending.pop()!, lifetime = result.get(node)!;
    let callees = edges.get(node);
    if (!callees) { callees = targets(node); edges.set(node, callees); }
    for (const target of callees) { budget.take(); merge(target, lifetime); }
  }
  return result;
}
