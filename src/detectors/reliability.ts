import { isRecord, parseRepoManifest, readRepoFile } from "../repoFiles.js";
import { isAxiosBinding, isHttpFetch } from "../bindings.js";
import ts from "typescript";
import { lineOf, snippetAt, makeFinding } from "./common.js";
import type { Finding } from "../types.js";
import { Workspace } from "../workspace.js";
import { detectFloatingPromises } from "./floatingPromise.js";

/**
 * Repo-level resilience gaps.
 *
 * These are findings about the project as a whole rather than a single call
 * site: there is no retry strategy anywhere, or the process has no
 * unhandled-rejection handler, so a single failed dependency can take the
 * instance down.
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

const RETRY_PATTERNS = [
  /\bretry\s*\(/i,
  /\bwithRetry\b/,
  /\bretryWhen\b/,
  /\bmaxRetries\b/,
  /\bbackoff\b/i,
  /\bretryCount\b/,
  /\battempts\s*[:=]/i,
];

export async function detectReliability(root: string, ws?: Workspace): Promise<Finding[]> {
  const out: Finding[] = [];
  const workspace = ws ?? (await Workspace.load(root));

  const pkg = parseRepoManifest(await readRepoFile(root, "package.json"));
  const deps = {
    ...(isRecord(pkg.dependencies) ? pkg.dependencies : {}),
    ...(isRecord(pkg.devDependencies) ? pkg.devDependencies : {}),
  };

  const hasOutboundCalls = workspace.units.some((u) => hasOutboundCall(u.sf));
  if (hasOutboundCalls) {
    const hasRetry =
      RETRY_PACKAGES.some((p) => p in deps) ||
      workspace.units.some((u) => RETRY_PATTERNS.some((re) => re.test(u.content)));

    if (!hasRetry) {
      const anchor = workspace.units.find((u) => hasOutboundCall(u.sf));
      if (anchor) {
        const ln = lineOf(anchor.sf, firstOutboundCall(anchor.sf));
        out.push(
          makeFinding({
            id: "no-retry-strategy",
            category: "Resilience",
            severity: "info",
            confidence: "low",
            file: anchor.rel,
            line: ln,
            message: "The project makes outbound HTTP calls but has no retry/backoff mechanism.",
            scaleTrigger: "A transient downstream error (429, 502, socket reset) fails the user request instead of recovering.",
            suggestedFix: "Add bounded retries with exponential backoff and jitter on transient failures only (never on 4xx).",
            snippet: snippetAt(anchor.content, ln),
          }),
        );
      }
    }
  }

  // Only worth reporting when there is something to reject: a floating promise
  // plus no process-level handler means one bad write can kill the instance.
  const floating = await detectFloatingPromises(root, workspace);
  const hasRejectionHandler = workspace.units.some((u) => hasUnhandledRejectionHandler(u.sf));
  if (floating.length > 0 && !hasRejectionHandler) {
    const anchor = workspace.units.find((u) => floating.some((f) => f.file === u.rel));
    if (anchor) {
      const ln = floating.find((f) => f.file === anchor.rel)?.line ?? 1;
      out.push(
        makeFinding({
          id: "missing-rejection-handler",
          category: "Resilience",
          severity: "medium",
          confidence: "medium",
          file: anchor.rel,
          line: ln,
          message: `This project has ${floating.length} unawaited promise(s) and no process-level \`unhandledRejection\` handler.`,
          scaleTrigger: "One rejected promise can terminate the whole process, taking every in-flight request on that instance with it.",
          suggestedFix: "Register `process.on('unhandledRejection', ...)` at startup, log it, and keep the process alive.",
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

function hasUnhandledRejectionHandler(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText();
      if (/^process\.(on|once)$/.test(callee)) {
        const first = node.arguments[0];
        if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
          if (/^(unhandledRejection|uncaughtException|unhandledRejectionError)$/.test(first.text)) {
            found = true;
            return;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}
