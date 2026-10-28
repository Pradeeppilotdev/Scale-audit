import { dependencies, processEvent, serviceContexts, type StartupContext } from "../serviceContext.js";
import { isAxiosBinding, isHttpFetch } from "../bindings.js";
import ts from "typescript";
import { lineOf, snippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";
import { Workspace } from "../workspace.js";
import { detectFloatingPromises } from "./floatingPromise.js";

/**
 * Service-scoped resilience evidence.
 *
 * Retry hints stay advisory and local to a file/package. Rejection protection
 * must be visible in every startup entry that owns the affected source; an
 * unrelated service cannot supply that evidence.
 */
const RETRY_PACKAGES = [
  "p-retry",
  "async-retry",
  "retry",
  "axios-retry",
  "node-fetch-retry",
  "cockatiel",
  "exponential-backoff",
  "promise-retry",
  "rate-limiter-flexible",
];

export async function detectReliability(root: string, ws?: Workspace): Promise<Finding[]> {
  const out: Finding[] = [];
  const workspace = ws ?? (await Workspace.load(root));

  const contexts = serviceContexts(root, workspace);
  // Advisory evidence is scoped to the owning package and parsed source, never comments.
  for (const unit of workspace.units) {
    if (!hasOutboundCall(unit.sf)) continue;
    const deps = dependencies(await contexts.manifest(unit));
    const hasRetry =
      RETRY_PACKAGES.some((p) => p in deps) ||
      hasRetrySyntax(unit.sf);

    if (!hasRetry) {
      const anchor = unit;
      const ln = lineOf(anchor.sf, firstOutboundCall(anchor.sf));
      out.push(
        makeFinding({
          id: "no-retry-strategy",
          category: "Resilience",
          severity: "info",
          confidence: "low",
          file: anchor.rel,
          line: ln,
          message: "Outbound HTTP calls have no visible retry/backoff evidence in this file or its package dependencies.",
          scaleTrigger: "A transient downstream error (429, 502, socket reset) fails the user request instead of recovering.",
          suggestedFix: "For retry-safe/idempotent operations, consider bounded retries with exponential backoff and jitter; respect Retry-After for 429/503 and avoid retrying permanent failures or duplicating writes.",
          snippet: snippetAt(anchor.content, ln),
        }),
      );
    }
  }

  // Only worth reporting when there is something to reject: a floating promise
  // plus no process-level handler means one bad write can kill the instance.
  const sites = new Map<Finding, ts.CallExpression>();
  const floating = await detectFloatingPromises(root, workspace, (finding, call) => sites.set(finding, call));
  const byFile = new Map<string, Finding[]>();
  for (const finding of floating) {
    const local = byFile.get(finding.file) ?? [];
    local.push(finding);
    byFile.set(finding.file, local);
  }
  const protectedOwners = new Map<StartupContext, boolean>();
  const containsHandler = (calls: ReadonlySet<ts.CallExpression>, owner: StartupContext): boolean => {
    for (const call of calls) if (processEvent(call, ["unhandledRejection"], owner)) return true;
    return false;
  };
  const hasHandler = (owner: StartupContext): boolean => {
    const cached = protectedOwners.get(owner);
    if (cached !== undefined) return cached;
    const protectedOwner = containsHandler(owner.protectiveCalls, owner);
    protectedOwners.set(owner, protectedOwner);
    return protectedOwner;
  };
  const protectedSites = new Map<StartupContext, Map<ts.CallExpression, boolean>>();
  const protectsSite = (owner: StartupContext, finding: Finding): boolean => {
    if (hasHandler(owner)) return true;
    const site = sites.get(finding);
    if (!site) return false;
    let cache = protectedSites.get(owner);
    if (!cache) { cache = new Map(); protectedSites.set(owner, cache); }
    const cached = cache.get(site);
    if (cached !== undefined) return cached;
    const invocations = owner.invocationsFor(site);
    const protectedSite = invocations.length > 0 && invocations.every(view =>
      containsHandler(view.protectionCallsFor(site), view));
    cache.set(site, protectedSite);
    return protectedSite;
  };
  for (const anchor of workspace.units) {
    const local = byFile.get(anchor.rel) ?? [];
    if (!local.length) continue;
    const owners = contexts.owners(anchor.sf);
    const unprotected = local.filter(finding => !owners.every(owner => protectsSite(owner, finding)));
    if (unprotected.length) {
      const ln = unprotected[0].line;
      out.push(
        makeFinding({
          id: "missing-rejection-handler",
          category: "Resilience",
          severity: "medium",
          confidence: "medium",
          file: anchor.rel,
          line: ln,
          message: `This project has ${unprotected.length} unhandled promise finding(s) in this file without a visible startup process-level \`unhandledRejection\` handler.`,
          scaleTrigger: "One rejected promise can terminate the whole process, taking every in-flight request on that instance with it.",
          suggestedFix: "Handle failures at the call site with await/catch first. At startup, log unexpected rejections and follow an explicit shutdown/restart policy; a global listener is not a substitute for handling failures.",
          snippet: snippetAt(anchor.content, ln),
        }),
      );
    }
  }

  return out;
}

function hasOutboundCall(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (isHttpFetch(expr)) {
        found = true;
        return;
      }
      if (ts.isPropertyAccessExpression(expr) && isAxiosBinding(expr.expression)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function firstOutboundCall(sf: ts.SourceFile): ts.Node {
  let found: ts.Node = sf;
  const visit = (node: ts.Node) => {
    if (found !== sf) return;
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (isHttpFetch(expr)) {
        found = node;
        return;
      }
      if (ts.isPropertyAccessExpression(expr) && isAxiosBinding(expr.expression)) {
        found = node;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function hasRetrySyntax(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression) ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : "";
      if (/^(retry|withRetry|retryWhen|backoff)$/i.test(name)) found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}
