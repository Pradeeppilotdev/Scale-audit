import ts from "typescript";
import { AnalysisBudget, projectWorkLimit } from "../analysisBudget.js";
import { checkerFor, definitionOf, symbolOf } from "../bindings.js";
import { conditionBoolean, conditionNullish, conditionTruth as literalTruth } from "../conditionTruth.js";
import { loopBindingEvaluations, requestReachability, type RequestReachability } from "../requestReachability.js";
import type { Finding } from "../types.js";
import { Workspace, type SourceUnit } from "../workspace.js";
import { lineOf, locationOf, makeFinding, sourceSnippetAt } from "./common.js";

type PlainFunction = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

interface Drain {
  receiver: ts.Identifier;
  emptyCheck?: ts.Identifier;
  call: ts.CallExpression;
  timer: ts.CallExpression;
  registration: ts.CallExpression;
  unref?: boolean;
  worker: PlainFunction;
  workerReference?: ts.Identifier;
  nonemptyJob: boolean;
  callbackReference?: ts.Identifier;
  callbackDeclaration?: ts.Identifier;
  handle?: ts.Symbol;
  mutableHandle?: boolean;
  cancelledAt?: ts.CallExpression;
  lateWorker?: ts.VariableDeclaration;
  available: boolean;
}

interface Queue {
  unit: SourceUnit;
  declaration: ts.VariableDeclaration;
  producers: ts.CallExpression[];
  depth?: ts.Symbol;
  drain?: Drain;
  excluded: boolean;
}

// A length read refers to the private array itself, independently of any
// application counter. Only the arrays discovered by this audit qualify.
const privateQueues = new WeakMap<AnalysisBudget, Map<ts.Symbol, Queue>>();
const intervalDelayAliases = new WeakMap<AnalysisBudget, WeakMap<ts.Symbol, ts.Expression>>();

/** Deliberately limited to private arrays whose complete set of source uses is visible. */
export async function detectQueueBackpressure(root: string, ws?: Workspace): Promise<Finding[]> {
  const workspace = ws ?? (await Workspace.load(root));
  const budget = new AnalysisBudget("Queue backpressure", projectWorkLimit(workspace.units.map(unit => unit.sf)));
  const timerAliases = new WeakMap<ts.Symbol, ts.Expression>();
  intervalDelayAliases.set(budget, timerAliases);
  const queues = new Map<ts.Symbol, Queue>();
  for (const unit of workspace.units) {
    for (const statement of unit.sf.statements) {
      budget.take();
      if (!ts.isVariableStatement(statement) || exported(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const declaration of statement.declarationList.declarations) {
        budget.take();
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const initial = unwrap(declaration.initializer, budget);
        if (!ts.isArrayLiteralExpression(initial) || initial.elements.length) continue;
        const symbol = symbolOf(declaration.name);
        if (symbol) queues.set(symbol, { unit, declaration, producers: [], excluded: false });
      }
    }
  }
  if (!queues.size) return [];
  privateQueues.set(budget, queues);

  const drains = new Map<ts.Identifier, Drain>();
  const emptyChecks = new Map<ts.Identifier, Drain>();
  const namedDrains = new Map<ts.Symbol, Drain>();
  const namedTimers = new Set<ts.Symbol>();
  const startupHelpers = new Map<ts.Symbol, { reference: ts.Identifier; name: ts.Identifier; drain: Drain }>();
  const registrationHelpers = new WeakMap<ts.Declaration, HelperRegistration | null>();
  const workerFunctions = new WeakMap<ts.Declaration, PlainFunction | null>();
  const names = new Set([...queues.keys()].map(symbol => symbol.name));
  let hasUnref = false;
  for (const { sf } of workspace.units) {
    const pending = [...sf.statements].reverse();
    while (pending.length) {
      const statement = pending.pop()!;
      budget.take();
      if (enqueueStartupStatements(statement, pending, budget)) continue;
      if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement) || startupSwitchStops(statement, budget)) break;
      for (const expression of entryExpressions(statement, budget)) {
        const site = startupInterval(expression, registrationHelpers, budget);
        if (!site) continue;
        const { timer, registration, result, unref, helper } = site;
        if (helper) {
          const earlier = startupHelpers.get(helper.symbol);
          if (earlier) { earlier.drain.available = false; continue; }
        }
        const reference = unwrap(timer.arguments[0], budget);
        const symbol = ts.isIdentifier(reference) ? symbolOf(reference) : undefined;
        if (symbol) {
          const declaration = symbol.valueDeclaration;
          if (declaration && ts.isVariableDeclaration(declaration) && declaration.pos >= registration.pos) continue;
          if (namedTimers.has(symbol)) {
            const previous = namedDrains.get(symbol);
            if (previous) previous.available = false;
            continue;
          }
          namedTimers.add(symbol);
        }
        const drain = scheduledDrain(timer, registration, result, reference, workerFunctions, budget);
        if (!drain || !queues.has(symbolOf(drain.receiver)!)) continue;
        drain.unref = unref;
        hasUnref ||= unref;
        if (helper) {
          startupHelpers.set(helper.symbol, { reference: helper.reference, name: helper.name, drain });
          names.add(helper.reference.text);
        }
        drains.set(drain.receiver, drain);
        if (drain.emptyCheck) emptyChecks.set(drain.emptyCheck, drain);
        if (symbol && drain.callbackReference) {
          names.add(drain.callbackReference.text);
          namedDrains.set(symbol, drain);
        }
      }
    }
  }
  if (!drains.size) return [];

  const mutableHandles = new Set<ts.Symbol>();
  const mutableNames = new Set<string>();
  for (const drain of drains.values()) {
    budget.take();
    if (drain.handle && drain.mutableHandle) {
      mutableHandles.add(drain.handle);
      mutableNames.add(drain.handle.name);
    }
  }
  const firstHandleWrites = new Map<ts.Symbol, number>();
  const visitedTargets = new WeakSet<ts.Expression>();
  const orderedBlocks = new WeakMap<ts.Block, boolean>();
  const globalAliases = new WeakMap<ts.Symbol, boolean>();
  const unsafeHostPatches = unsafeHostPatchAliases(workspace, timerAliases, budget);
  const hostPatchShapes = new WeakMap<ts.ObjectLiteralExpression, ReadonlySet<string> | null>();
  const patchWrites = hasUnref ? unrefPatchWrites(workspace, timerAliases, orderedBlocks, budget) : undefined;
  const patchShapes: PatchShapes = new WeakMap();
  const timerPrototypes = new WeakMap<ts.Expression, boolean>();
  const replacedTimers: TimerWrites = new Map();
  const writtenNames = new Set<string>();
  const loopWrites: LoopWrites = { bindings: new Map(), evals: new WeakMap(), sorted: new WeakSet() };
  let unrefMayBeReplaced = false;
  const admission: AdmissionIndex = Object.assign(new WeakMap<ts.Node, AdmissionFacts>(), {
    writtenNames, loopWrites, booleanWrites: replacedTimers, globalAliases, timerAliases, orderedBlocks,
    booleanOrigins: new WeakMap<ts.Symbol, BooleanOrigin | null>(),
    booleanHelperWrites: new Map(), booleanNativeHelperWrites: new Map(), booleanOwnHelperWrites: new WeakMap(),
    booleanHelperReads: new WeakMap(), booleanHelperShapes: new WeakMap(),
    booleanHelperTargets: new WeakSet(), booleanReadPositions: new WeakMap(),
    scalarOwnerCache: new WeakMap<ts.Node, ts.SignatureDeclaration | null>(),
    scalarCandidates: new Set<ts.Symbol>(), scalarRecords: new Map<ts.Symbol, ScalarRecords>(),
    scalarBoundedCounters: new Set<ts.Symbol>(),
    scalarBarrierMemo: new WeakMap<ts.Expression, Map<number, ScalarBarrier | "always" | null>>(),
    scalarAtoms: new WeakMap<ts.Symbol, Map<string, ScalarBarrier>>(),
    scalarCombinations: new Map<"and" | "or", WeakMap<ScalarBarrier, WeakMap<ScalarBarrier, ScalarBarrier>>>(),
    barrierSeen: new WeakMap<ScalarCheck[], Map<string | ScalarBarrier, number>>(),
    guardExpressions: new WeakMap<ts.Expression, ts.Expression>(),
    guardNullish: new WeakMap<ts.Expression, boolean | null>(),
    guardTruth: new WeakMap<ts.Expression, boolean | null>(),
    guardBounds: new WeakMap<ts.Symbol, Map<ts.Symbol | undefined, GuardBound>>(),
    guardStartups: new WeakMap<ts.Node, ts.Statement | null>(),
    guardProofs: new WeakMap<object, WeakMap<ts.Expression, Map<number, CachedGuardProof[]>>>(),
    guardUnknownStartup: {}, relevantCounters: new Set<ts.Symbol>(),
    guardSharedProofs: new WeakMap<ts.Expression, Map<number, GuardProof>>(),
    capacityCache: { unit: new WeakMap<object, ReadonlySet<ts.Symbol> | null>(),
      batch: new WeakMap<object, ReadonlySet<ts.Symbol> | null>() },
    guardComparisons: new WeakMap<GuardBound, GuardProof>(),
    guardEmpty: [{ bounds: new Set<GuardBound>(), mentions: new Set<ts.Symbol>() },
      { bounds: new Set<GuardBound>(), mentions: new Set<ts.Symbol>(), exactType: true }] as const,
    guardMentions: [new WeakMap<ts.Symbol, GuardProof>(), new WeakMap<ts.Symbol, GuardProof>()] as const,
    guardCounterIds: new Map<ts.Symbol, number>(), guardMultipleMentions: new Map<string, GuardProof>(),
    guardCombinations: new Map<number, WeakMap<GuardProof, WeakMap<GuardProof, GuardProof>>>(),
    guardBooleanViews: new WeakMap<GuardProof, GuardProof>(),
    guardUncertainViews: new WeakMap<GuardProof, GuardProof>(),
    guardUntrustedViews: new WeakMap<GuardProof, GuardProof>(),
  });
  for (const { sf } of workspace.units) {
    const pending: ts.Node[] = [sf];
    while (pending.length) {
      budget.take();
      const node = pending.pop()!;
      const scalarExpression = ts.isIfStatement(node) ? node.expression
        : ts.isReturnStatement(node) ? node.expression
          : ts.isArrowFunction(node) && !ts.isBlock(node.body) ? node.body
            : ts.isBinaryExpression(node) ? node : undefined;
      if (scalarExpression) {
        const counter = scalarCandidate(scalarExpression, budget);
        if (counter) admission.scalarCandidates.add(counter);
      }
      // Calls and logical expressions may wrap a bare counter in Boolean
      // (including .call/.apply and normalizations such as count || 0).
      // This is only candidate discovery; scalarBarrier still verifies the
      // callee and its result before any admission evidence is accepted.
      const scalarInputs = ts.isCallExpression(node) ? node.arguments
        : ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.BarBarToken
          || node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
          || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) ? [node.left, node.right] : undefined;
      if (scalarInputs) for (const argument of scalarInputs) {
        budget.take();
        const counter = scalarCandidate(argument, budget);
        if (counter) admission.scalarCandidates.add(counter);
      }
      if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
        const counter = scalarCandidate(node, budget);
        if (counter) admission.scalarCandidates.add(counter);
      }
      if (ts.isIdentifier(node) && node.text === "eval") addLoopWrite(loopWrites.evals, sf, node.pos);
      if (nativeMethodsUncertain(node, budget)) return [];
      if (patchWrites && !unrefMayBeReplaced
        && (ts.isCallExpression(node) && unrefMutator(node, timerAliases, patchWrites, patchShapes, timerPrototypes, registrationHelpers, budget)
          || unrefWrite(node, timerAliases, timerPrototypes, registrationHelpers, budget))) {
        unrefMayBeReplaced = true;
      }
      if (ts.isCallExpression(node)) markTimerMutator(node, replacedTimers, globalAliases, timerAliases, unsafeHostPatches,
        hostPatchShapes, orderedBlocks, budget);
      const target = writeTarget(node);
      markBooleanHelperMutation(node, target, admission, unsafeHostPatches, budget);
      if (target) {
        if (indexWrites(target, node, mutableNames, mutableHandles, firstHandleWrites,
          replacedTimers, writtenNames, visitedTargets, orderedBlocks, globalAliases, timerAliases, loopWrites, budget)) return [];
      }
      if (replacedTimers.has("setInterval")) return [];
      if (ts.isIdentifier(node) && names.has(node.text)) {
        const symbol = referenceSymbol(node);
        const helper = symbol && startupHelpers.get(symbol);
        if (helper && node !== helper.reference && node !== helper.name) helper.drain.available = false;
        const named = symbol && namedDrains.get(symbol);
        if (named && node !== named.callbackReference && node !== named.callbackDeclaration) named.available = false;
        const queue = symbol && queues.get(symbol);
        if (queue && node !== queue.declaration.name) {
          const drain = drains.get(node);
          if (drain && !queue.drain) queue.drain = drain;
          else if (!drain && !emptyChecks.has(node)) {
            if (namedAccess(node.parent, "length") === node) { queue.depth = symbol; continue; }
            const push = plainEnqueue(node);
            if (push) queue.producers.push(push);
            else if (!readOnlyQueueCall(node)) queue.excluded = true;
          } else if (drain) queue.excluded = true;
        }
      }
      ts.forEachChild(node, child => { pending.push(child); });
    }
  }

  if (unrefMayBeReplaced) for (const drain of drains.values()) {
    budget.take();
    if (drain.unref) drain.available = false;
  }
  if (replacedTimers.has("Boolean")) writtenNames.add("Boolean");
  checkDrainStartup(workspace, drains.values(), firstHandleWrites, replacedTimers, writtenNames, timerAliases, budget);
  const candidates = [...queues.values()].filter(queue => !queue.excluded && queue.drain?.available && queue.producers.length);
  if (!candidates.length) return [];
  const requests = requestReachability(workspace);
  admission.nativeQueueCall = requests.nativeQueueCall;
  const counters = queueCounters(candidates, requests, workspace, budget);
  budget.take(counters.valid.size + counters.invalid.size);
  const validCounters = [...counters.valid];
  for (const queue of candidates) {
    budget.take();
    if (queue.depth) validCounters.push([queue, queue.depth]);
  }
  admission.scalarUnitOwners = scalarUnitOwners(validCounters, requests, admission.scalarOwnerCache, budget);
  const knownQueueCounters = { symbols: new Set(counters.invalid.values()) };
  for (const [, counter] of validCounters) { budget.take(); knownQueueCounters.symbols.add(counter); }
  admission.relevantCounters = knownQueueCounters.symbols;
  prepareScalarAdmission(validCounters, requests, admission, counters.reservations, budget);
  const guards = guardedProducerCalls(candidates, requests, admission, counters, knownQueueCounters, budget);
  const findings: Finding[] = [];
  for (const queue of candidates) {
    const { unit, declaration, drain, producers } = queue;
    budget.take();
    const counter = counters.valid.get(queue);
    if (counter && admission.scalarBoundedCounters.has(counter) || queue.depth && admission.scalarBoundedCounters.has(queue.depth)) continue;
    const enqueue = producers.reduce<ts.CallExpression | undefined>((first, call) => {
      budget.take();
      if (first && call.pos >= first.pos || requests.evidence(call) !== "request") return first;
      const facts = callAdmission(call, admission, budget);
      if (facts?.unreachable) return first;
      if (facts?.state === "resumed" && counter && counters.reservations.get(call) === counter) {
        // The slot was claimed before argument evaluation. Only a guard on
        // this verified counter covers in-flight jobs awaiting their payload.
        const atReservation = callAdmission(call, admission, budget, call.pos);
        if (atReservation && (cachedCapacityChecks(atReservation, knownQueueCounters, admission.capacityCache, budget)?.has(counter)
          || atReservation.state !== "resumed" && guards.reserved(queue, counter, call))) return first;
      }
      const capacity = facts && cachedCapacityChecks(facts, knownQueueCounters, admission.capacityCache, budget);
      const state = facts && counterAdmissionState(facts, counter, counters.invalid.get(queue), capacity, budget, queue.depth);
      return state === "resumed" || state === "open" && !guards.producers.has(call) ? call : first;
    }, undefined);
    if (!enqueue) continue;
    const { line, column } = locationOf(unit.sf, enqueue);
    const queueLine = lineOf(unit.sf, declaration);
    const timerLine = lineOf(unit.sf, drain!.timer);
    const drainLine = lineOf(unit.sf, drain!.call);
    const cancelled = drain!.cancelledAt;
    findings.push(makeFinding({
      id: "unbounded-request-queue",
      category: "Concurrency",
      severity: "medium",
      confidence: "high",
      file: unit.rel,
      line, column,
      message: `Request work is appended to a private queue (line ${queueLine}) without a visible capacity check. `
        + (cancelled
          ? `Startup cancels the interval registered at line ${timerLine} (line ${lineOf(unit.sf, cancelled)}), leaving no visible active drain.`
          : `The interval registered at line ${timerLine} dequeues at most one job per tick (line ${drainLine}).`),
      scaleTrigger: cancelled
        ? "Jobs accumulate because the interval is cancelled before it can drain them, increasing memory use and delaying jobs."
        : "If requests enqueue jobs faster than the interval removes them, the backlog grows, increasing memory use and delaying jobs.",
      suggestedFix: "Set a maximum pending job count and define what happens when full. Reject, defer, or otherwise slow producers, and monitor queue depth and job wait time.",
      snippet: sourceSnippetAt(unit.sf, line),
    }));
  }
  return findings;
}

function exported(node: ts.VariableStatement | ts.FunctionDeclaration): boolean {
  return !!ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function unwrapParent(node: ts.Node): node is ts.ParenthesizedExpression | ts.AsExpression
  | ts.SatisfiesExpression | ts.NonNullExpression | ts.TypeAssertion {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
    || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node);
}

function unwrap(expression: ts.Expression, budget: AnalysisBudget): ts.Expression {
  while (unwrapParent(expression)) {
    budget.take();
    expression = expression.expression;
  }
  return expression;
}

interface TimerRegistration {
  timer: ts.CallExpression;
  registration: ts.CallExpression;
  result?: ts.CallExpression;
  unref: boolean;
  helper?: { symbol: ts.Symbol; reference: ts.Identifier; name: ts.Identifier };
}

type HelperRegistration = Pick<TimerRegistration, "timer" | "unref"> & { returnsHandle: boolean };

function intervalCall(call: ts.CallExpression, budget: AnalysisBudget): Pick<TimerRegistration, "timer" | "unref"> | undefined {
  if (call.questionDotToken) return undefined;
  const callee = unwrap(call.expression, budget);
  const receiver = !call.arguments.length && !("questionDotToken" in callee && callee.questionDotToken)
    && namedAccess(callee, "unref");
  const timer = receiver ? unwrap(receiver, budget) : call;
  if (!ts.isCallExpression(timer) || timer.questionDotToken || !ts.isIdentifier(timer.expression)
    || timer.expression.text !== "setInterval" || symbolOf(timer.expression)
    || timer.arguments.length !== 2) return undefined;
  const literal = initializedAlias(timer.arguments[1], intervalDelayAliases.get(budget)!, budget);
  if (!ts.isNumericLiteral(literal)) return undefined;
  const delay = Number(literal.text);
  if (delay < 1 || delay > 2_147_483_647) return undefined;
  return { timer, unref: !!receiver };
}

function startupInterval(expression: ts.Expression, summaries: WeakMap<ts.Declaration, HelperRegistration | null>,
  budget: AnalysisBudget): TimerRegistration | undefined {
  const call = unwrap(expression, budget);
  if (!ts.isCallExpression(call)) return undefined;
  const direct = intervalCall(call, budget);
  if (direct) return { ...direct, registration: call, result: call };
  if (call.questionDotToken || call.arguments.length || !ts.isIdentifier(call.expression)) return undefined;
  const reference = call.expression;
  const symbol = symbolOf(reference);
  const declaration = symbol?.valueDeclaration;
  if (!symbol || symbol.declarations?.length !== 1 || !declaration) return undefined;
  const name = (ts.isFunctionDeclaration(declaration) || ts.isVariableDeclaration(declaration)) && declaration.name;
  if (!name || !ts.isIdentifier(name)) return undefined;
  if (ts.isVariableDeclaration(declaration) && declaration.end >= call.pos) return undefined;
  let registered = summaries.get(declaration);
  if (registered === undefined) {
    const helper = plainFunction(reference, call, budget);
    const body = helper && !helper.parameters.length && helper.body;
    registered = body ? helperRegistration(body, budget) ?? null : null;
    summaries.set(declaration, registered);
  }
  if (!registered) return undefined;
  return {
    timer: registered.timer,
    unref: registered.unref,
    registration: call,
    result: registered.returnsHandle ? call : undefined,
    helper: { symbol, reference, name },
  };
}

function helperRegistration(body: ts.ConciseBody, budget: AnalysisBudget): HelperRegistration | undefined {
  let start = 0;
  if (ts.isBlock(body)) {
    while (start < body.statements.length && (ts.isFunctionDeclaration(body.statements[start])
      || ts.isEmptyStatement(body.statements[start]))) {
      budget.take();
      start++;
    }
  }
  const first = ts.isBlock(body) ? body.statements[start] : body;
  if (ts.isBlock(body) && first && ts.isVariableStatement(first)
    && first.declarationList.flags & ts.NodeFlags.Const && first.declarationList.declarations.length === 1) {
    const declaration = first.declarationList.declarations[0];
    const last = body.statements.at(-1);
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer
      || !last || !ts.isReturnStatement(last) || !last.expression) return undefined;
    const call = unwrap(declaration.initializer, budget);
    const returned = unwrap(last.expression, budget);
    if (!ts.isCallExpression(call) || !ts.isIdentifier(returned)
      || symbolOf(returned) !== symbolOf(declaration.name)) return undefined;
    const registration = intervalCall(call, budget);
    if (!registration) return undefined;
    for (let index = start + 1; index < body.statements.length - 1; index++) {
      budget.take();
      if (!startupLog(body.statements[index], budget)) return undefined;
    }
    return { ...registration, returnsHandle: true };
  }
  const call = first && workCall(first, budget);
  const registration = call && intervalCall(call, budget);
  if (!registration) return undefined;
  const returnsHandle = !ts.isBlock(body) || ts.isReturnStatement(first);
  if (ts.isBlock(body) && !returnsHandle) {
    for (let index = start + 1; index < body.statements.length; index++) {
      budget.take();
      if (!startupLog(body.statements[index], budget)) return undefined;
    }
  }
  // A void wrapper registers the interval without returning its handle.
  const value = ts.isReturnStatement(first) ? first.expression : !ts.isBlock(body) ? body : undefined;
  return { ...registration, returnsHandle: returnsHandle && !!value && unwrap(value, budget) === call };
}

function startupLog(statement: ts.Statement, budget: AnalysisBudget): boolean {
  if (ts.isEmptyStatement(statement)) return true;
  if (!ts.isExpressionStatement(statement)) return false;
  const call = workCall(statement, budget);
  if (!call || !ts.isPropertyAccessExpression(call.expression)) return false;
  const { expression, name } = call.expression;
  if (!ts.isIdentifier(expression) || expression.text !== "console" || !hostIdentifier(expression)
    || !["debug", "info", "log", "warn", "error"].includes(name.text)) return false;
  for (const argument of call.arguments) {
    budget.take();
    const value = unwrap(argument, budget);
    if (!ts.isStringLiteralLike(value) && !ts.isNumericLiteral(value)) return false;
  }
  return true;
}

/** A synchronous startup cancellation can be established only before startup yields. */
function checkDrainStartup(workspace: Workspace, drains: Iterable<Drain>, firstHandleWrites: Map<ts.Symbol, number>,
  replacedCancellation: TimerWrites, writtenNames: Set<string>, timerAliases: WeakMap<ts.Symbol, ts.Expression>,
  budget: AnalysisBudget): void {
  const handles = new Map<ts.Symbol, Drain>();
  const sources = new Map<ts.SourceFile, Drain[]>();
  for (const drain of drains) {
    budget.take();
    if (drain.handle) handles.set(drain.handle, drain);
    const source = drain.registration.getSourceFile();
    const list = sources.get(source) ?? [];
    list.push(drain);
    sources.set(source, list);
  }
  if (!sources.size) return;
  const helperCancellations = new WeakMap<PlainFunction, Cancellation | null>();
  for (const { sf } of workspace.units) {
    budget.take();
    const sourceDrains = sources.get(sf);
    if (!sourceDrains) continue;
    const needsTiming = sourceDrains.some(drain => { budget.take(); return drain.handle || drain.lateWorker; });
    const startupGlobals = new WeakMap<ts.Symbol, boolean>();
    const branchCompletions = new WeakMap<ts.Statement, number>();
    const suspensions: number[] = [];
    const aliases = new Map<ts.Symbol, Drain>();
    const handleAt = (symbol: ts.Symbol, position: number): Drain | undefined =>
      aliases.get(symbol) ?? (position < (firstHandleWrites.get(symbol) ?? Infinity) ? handles.get(symbol) : undefined);
    const pending = [...sf.statements].reverse();
    let abrupt = Infinity;
    let possibleAbrupt = -1;
    while (pending.length) {
      const statement = pending.pop()!;
      budget.take();
      if (enqueueStartupStatements(statement, pending, budget)) continue;
      if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement) || startupSwitchStops(statement, budget)) {
        abrupt = statement.pos;
        break;
      }
      if (ts.isIfStatement(statement)) {
        const completion = startupCompletion(statement, branchCompletions, budget);
        if (!(completion & STARTUP_NORMAL)) {
          abrupt = statement.pos;
          break;
        }
        if (completion & STARTUP_ABRUPT) possibleAbrupt = statement.pos;
      }
      if (!needsTiming) continue;
      const previous = suspensions.length;
      startupSuspensions(statement, suspensions, budget);
      if (suspensions.length !== previous) continue;
      if (ts.isIfStatement(statement) && statement.elseStatement) {
        const branchCall = (branch: ts.Statement): ts.CallExpression | undefined => {
          const single = onlyStatement(branch);
          return single && ts.isExpressionStatement(single) && ts.isCallExpression(single.expression) ? single.expression : undefined;
        };
        const left = branchCall(statement.thenStatement);
        const right = branchCall(statement.elseStatement);
        if (left && right) {
          const first = cancelledHandle(left, startupGlobals, replacedCancellation, writtenNames, timerAliases, helperCancellations, budget);
          const second = cancelledHandle(right, startupGlobals, replacedCancellation, writtenNames, timerAliases, helperCancellations, budget);
          const drain = first && first === second && handleAt(first, statement.pos);
          if (drain && possibleAbrupt <= drain.registration.pos && (suspensions.at(-1) ?? -1) <= drain.registration.pos
            && drain.registration.end <= statement.pos) drain.cancelledAt ??= left;
        }
      }
      for (const expression of entryExpressions(statement, budget)) {
        const value = unwrap(expression, budget);
        const binding = expression.parent;
        if (ts.isVariableDeclaration(binding) && ts.isIdentifier(binding.name)
          && binding.parent.flags & ts.NodeFlags.Const && ts.isIdentifier(value)) {
          const symbol = symbolOf(value);
          const drain = symbol && handleAt(symbol, expression.pos);
          const alias = symbolOf(binding.name);
          if (drain && alias && drain.registration.end <= expression.pos) aliases.set(alias, drain);
        }
        if (!ts.isCallExpression(value) || value.questionDotToken) continue;
        const symbol = cancelledHandle(value, startupGlobals, replacedCancellation, writtenNames, timerAliases, helperCancellations, budget);
        const drain = symbol && handleAt(symbol, value.pos);
        if (drain && possibleAbrupt <= drain.registration.pos && (suspensions.at(-1) ?? -1) <= drain.registration.pos
          && drain.registration.end <= value.pos) {
          drain.cancelledAt ??= value;
        }
      }
    }
    for (const drain of sourceDrains) {
      budget.take();
      if (drain.registration.pos >= abrupt) drain.available = false;
      if (!drain.lateWorker) continue;
      if (drain.lateWorker.pos >= abrupt) drain.available = false;
      const first = firstAfter(suspensions, drain.registration.pos, budget);
      if (first !== undefined && first <= drain.lateWorker.pos) drain.available = false;
    }
  }
}

function enqueueStartupStatements(statement: ts.Statement, pending: ts.Statement[], budget: AnalysisBudget): boolean {
  if (ts.isBlock(statement)) {
    for (let i = statement.statements.length - 1; i >= 0; i--) {
      budget.take();
      pending.push(statement.statements[i]);
    }
    return true;
  }
  if (ts.isIfStatement(statement)) {
    const branches = startupBranches(statement, budget);
    if (branches.length !== 1) return false;
    if (branches[0]) pending.push(branches[0]);
    return true;
  }
  if (ts.isTryStatement(statement) && !statement.catchClause && statement.finallyBlock?.statements.length === 0) {
    pending.push(statement.tryBlock);
    return true;
  }
  return false;
}

/** Narrowly recognize literal switch dispatch with a straight-line abrupt exit. */
function startupSwitchStops(statement: ts.Statement, budget: AnalysisBudget): boolean {
  if (!ts.isSwitchStatement(statement)) return false;
  const value = switchLiteral(statement.expression, budget);
  if (value === undefined) return false;
  let selected = -1;
  let fallback = -1;
  const clauses = statement.caseBlock.clauses;
  for (let i = 0; i < clauses.length; i++) {
    budget.take();
    const clause = clauses[i];
    if (ts.isDefaultClause(clause)) fallback = i;
    else {
      const key = switchLiteral(clause.expression, budget);
      if (key === undefined) return false;
      if (key === value) { selected = i; break; }
    }
  }
  if (selected < 0) selected = fallback;
  if (selected < 0) return false;
  const branchCompletions = new WeakMap<ts.Statement, number>();
  for (let i = selected; i < clauses.length; i++) {
    const pending = [...clauses[i].statements].reverse();
    while (pending.length) {
      budget.take();
      const child = pending.pop()!;
      if (enqueueStartupStatements(child, pending, budget)) continue;
      if (ts.isReturnStatement(child) || ts.isThrowStatement(child)) return true;
      if (ts.isIfStatement(child) && startupCompletion(child, branchCompletions, budget) === STARTUP_ABRUPT) return true;
      if (!ts.isExpressionStatement(child) && !ts.isVariableStatement(child)
        && !ts.isEmptyStatement(child) && !ts.isFunctionDeclaration(child)) return false;
    }
  }
  return false;
}

function startupBranches(statement: ts.IfStatement, budget: AnalysisBudget): Array<ts.Statement | undefined> {
  const test = unwrap(statement.expression, budget);
  if (test.kind === ts.SyntaxKind.TrueKeyword) return [statement.thenStatement];
  if (test.kind === ts.SyntaxKind.FalseKeyword) return [statement.elseStatement];
  return [statement.thenStatement, statement.elseStatement];
}

const STARTUP_NORMAL = 1;
const STARTUP_ABRUPT = 2;
const STARTUP_BREAK = 4;

function startupCompletion(statement: ts.Statement, memo: WeakMap<ts.Statement, number>, budget: AnalysisBudget): number {
  const pending: Array<{ node: ts.Statement; expanded: boolean }> = [{ node: statement, expanded: false }];
  while (pending.length) {
    budget.take();
    const { node, expanded } = pending.pop()!;
    if (memo.has(node)) continue;
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
      memo.set(node, STARTUP_ABRUPT);
      continue;
    }
    if (ts.isBreakStatement(node)) {
      memo.set(node, STARTUP_BREAK);
      continue;
    }
    const children = ts.isBlock(node) ? node.statements : ts.isIfStatement(node) ? startupBranches(node, budget) : [];
    if (expanded || !children.length) {
      let completion = ts.isBlock(node) || !children.length ? STARTUP_NORMAL : 0;
      for (const child of children) {
        budget.take();
        const next = child ? memo.get(child)! : STARTUP_NORMAL;
        if (ts.isBlock(node)) {
          if (!(completion & STARTUP_NORMAL)) break;
          completion = (completion & ~STARTUP_NORMAL) | next;
        } else completion |= next;
      }
      memo.set(node, completion);
      continue;
    }
    pending.push({ node, expanded: true });
    for (const child of children) {
      budget.take();
      if (child) pending.push({ node: child, expanded: false });
    }
  }
  return memo.get(statement)!;
}

interface Cancellation {
  method: string;
  handle: ts.Symbol;
  capture?: ts.Expression;
}

function cancelledHandle(call: ts.CallExpression, globals: WeakMap<ts.Symbol, boolean>, replaced: TimerWrites,
  writtenNames: Set<string>, timerAliases: WeakMap<ts.Symbol, ts.Expression>,
  helperCancellations: WeakMap<PlainFunction, Cancellation | null>, budget: AnalysisBudget): ts.Symbol | undefined {
  const cancellation = (candidate: ts.CallExpression, callee: ts.Expression): Cancellation | undefined => {
    if (candidate.questionDotToken || candidate.arguments.length !== 1) return undefined;
    const method = cancellationMethod(callee, globals, budget);
    if (!method) return undefined;
    const argument = unwrap(candidate.arguments[0], budget);
    const handle = ts.isIdentifier(argument) ? symbolOf(argument) : undefined;
    return handle ? { method, handle, capture: unwrap(candidate.expression, budget) === callee ? undefined : callee } : undefined;
  };
  const stillNative = ({ method, capture }: Cancellation): boolean => {
    if (!replaced.has(method)) return true;
    const write = replaced.get(method);
    const at = capture ?? call;
    return !!write && write.source === at.getSourceFile() && at.pos < write.position;
  };
  const target = initializedAlias(call.expression, timerAliases, budget);
  const direct = cancellation(call, target);
  if (direct) return stillNative(direct) ? direct.handle : undefined;
  const declaration = ts.isIdentifier(target) ? symbolOf(target)?.valueDeclaration : undefined;
  if (declaration && ts.isFunctionDeclaration(declaration) && (!declaration.name || writtenNames.has(declaration.name.text)
    || !ts.isSourceFile(declaration.parent) || symbolOf(declaration.name)?.declarations?.length !== 1)) return undefined;
  const helper = plainFunction(target, call, budget);
  if (!helper?.body || helper.parameters.length !== call.arguments.length
    || call.arguments.length > 1 || call.arguments.some(argument => !ts.isIdentifier(unwrap(argument, budget)))) return undefined;
  let summary = helperCancellations.get(helper);
  if (summary === undefined) {
    summary = null;
    if (!helper.parameters.some(parameter => { budget.take(); return !ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken; })) {
      const body = ts.isBlock(helper.body) ? onlyStatement(helper.body) : helper.body;
      const inner = body && workCall(body, budget);
      summary = inner && cancellation(inner, initializedAlias(inner.expression, timerAliases, budget)) || null;
    }
    helperCancellations.set(helper, summary);
  }
  if (!summary || !stillNative(summary)) return undefined;
  const symbol = summary.handle;
  for (let i = 0; i < helper.parameters.length; i++) {
    budget.take();
    if (symbolOf(helper.parameters[i].name) !== symbol) continue;
    const argument = unwrap(call.arguments[i], budget);
    return ts.isIdentifier(argument) ? symbolOf(argument) : undefined;
  }
  return symbol;
}

function firstAfter(positions: number[], offset: number, budget: AnalysisBudget): number | undefined {
  let low = 0, high = positions.length;
  while (low < high) {
    budget.take();
    const middle = low + Math.floor((high - low) / 2);
    if (positions[middle] > offset) high = middle;
    else low = middle + 1;
  }
  return positions[low];
}

function startupSuspensions(statement: ts.Statement, positions: number[], budget: AnalysisBudget): void {
  // The stack visits siblings right to left. Sort only the new positions so
  // the prior statements' offsets stay reusable by subsequent callers.
  const pending: ts.Node[] = [statement];
  const current: number[] = [];
  while (pending.length) {
    budget.take();
    const node = pending.pop()!;
    if (ts.isAwaitExpression(node) || ts.isForOfStatement(node) && node.awaitModifier) current.push(node.pos);
    if (!ts.isFunctionLike(node)) ts.forEachChild(node, child => { pending.push(child); });
  }
  current.sort((left, right) => { budget.take(); return left - right; });
  for (const pos of current) { budget.take(); positions.push(pos); }
}

function entryExpressions(statement: ts.Statement, budget: AnalysisBudget): ts.Expression[] {
  if (ts.isExpressionStatement(statement)) return [statement.expression];
  if (!ts.isVariableStatement(statement)) return [];
  const expressions: ts.Expression[] = [];
  for (const decl of statement.declarationList.declarations) {
    budget.take();
    if (decl.initializer) expressions.push(decl.initializer);
  }
  return expressions;
}

function referenceSymbol(node: ts.Identifier): ts.Symbol | undefined {
  if (ts.isExportSpecifier(node.parent) && !node.parent.parent.parent.moduleSpecifier
    && node === (node.parent.propertyName ?? node.parent.name)) {
    return checkerFor(node.getSourceFile()).getExportSpecifierLocalTargetSymbol(node.parent);
  }
  return symbolOf(node);
}

function plainFunction(value: ts.Expression, at: ts.Node | undefined, budget: AnalysisBudget,
  workerFunctions?: WeakMap<ts.Declaration, PlainFunction | null>): PlainFunction | undefined {
  const expr = unwrap(value, budget);
  const declaration = ts.isIdentifier(expr) ? symbolOf(expr)?.valueDeclaration : undefined;
  if (declaration && workerFunctions?.has(declaration)) return workerFunctions.get(declaration) ?? undefined;
  let target: ts.Node = expr;
  if (declaration && ts.isFunctionDeclaration(declaration) && !exported(declaration)) target = declaration;
  else if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && (!at || declaration.pos < at.pos)
    && declaration.parent.flags & ts.NodeFlags.Const
    && ts.isVariableStatement(declaration.parent.parent) && !exported(declaration.parent.parent)) {
    target = unwrap(declaration.initializer, budget);
  }
  const result = (ts.isArrowFunction(target) || ts.isFunctionExpression(target) || ts.isFunctionDeclaration(target))
    && target.body && !(ts.isFunctionExpression(target) || ts.isFunctionDeclaration(target) ? target.asteriskToken : undefined)
    && !ts.getModifiers(target)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) ? target : undefined;
  if (declaration) workerFunctions?.set(declaration, result ?? null);
  return result;
}

function scheduledDrain(timer: ts.CallExpression, registration: ts.CallExpression, result: ts.CallExpression | undefined, reference: ts.Expression,
  workerFunctions: WeakMap<ts.Declaration, PlainFunction | null>, budget: AnalysisBudget): Drain | undefined {
  const callback = plainFunction(reference, registration, budget);
  if (!callback?.body || callback.parameters.length || ts.isFunctionExpression(callback) && callback.name) return undefined;
  const callbackReference = ts.isIdentifier(reference) ? reference : undefined;
  const declaredName = callbackReference && symbolOf(callbackReference)?.valueDeclaration;
  const callbackDeclaration = declaredName && (ts.isVariableDeclaration(declaredName) || ts.isFunctionDeclaration(declaredName))
    && declaredName.name && ts.isIdentifier(declaredName.name) ? declaredName.name : undefined;
  let body: ts.Node = callback.body;
  let emptyCheck: ts.Identifier | undefined;
  let nonemptyJob = false;
  let argument: ts.Expression | undefined;
  if (ts.isBlock(body)) {
    let step = 0;
    const first = body.statements[0];
    if (first && ts.isIfStatement(first) && !first.elseStatement && exits(first.thenStatement)) {
      const condition = unwrap(first.expression, budget);
      if (ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken) {
        const tested = unwrap(condition.operand, budget);
        if (ts.isPropertyAccessExpression(tested) && !tested.questionDotToken && tested.name.text === "length" && ts.isIdentifier(tested.expression)) {
          emptyCheck = tested.expression;
          step++;
        }
      }
    }
    const binding = body.statements[step];
    if (binding && ts.isVariableStatement(binding) && binding.declarationList.flags & ts.NodeFlags.Const
      && binding.declarationList.declarations.length === 1) {
      const decl = binding.declarationList.declarations[0];
      if (!ts.isIdentifier(decl.name) || !decl.initializer) return undefined;
      argument = decl.initializer;
      const expected = symbolOf(decl.name);
      const isJob = (test: ts.Expression): boolean => {
        const expr = unwrap(test, budget);
        return ts.isIdentifier(expr) && !!expected && symbolOf(expr) === expected;
      };
      step++;
      const guard = body.statements[step];
      if (guard && ts.isIfStatement(guard) && !guard.elseStatement) {
        const condition = unwrap(guard.expression, budget);
        if (exits(guard.thenStatement) && ts.isPrefixUnaryExpression(condition)
          && condition.operator === ts.SyntaxKind.ExclamationToken && isJob(condition.operand)) { step++; nonemptyJob = true; }
      }
      if (body.statements.length !== step + 1) return undefined;
      const last = body.statements[step];
      const worker = ts.isIfStatement(last) && !last.elseStatement && presentJob(last.expression, isJob, budget)
        ? onlyStatement(last.thenStatement) : last;
      nonemptyJob ||= worker !== last && ts.isIfStatement(last) && presentJob(last.expression, isJob, budget, true);
      const work = worker && workCall(worker, budget);
      if (!work || work.arguments.length !== 1 || !isJob(work.arguments[0])) return undefined;
      body = work;
    } else {
      if (body.statements.length !== step + 1) return undefined;
      body = binding;
    }
  }
  const work = workCall(body, budget);
  const workerFunction = work && plainFunction(work.expression, undefined, budget, workerFunctions);
  if (!work || work.arguments.length !== 1 || !workerFunction) return undefined;
  const worker = unwrap(work.expression, budget);
  const workerDeclaration = ts.isIdentifier(worker) ? symbolOf(worker)?.valueDeclaration : undefined;
  const lateWorker = workerDeclaration && ts.isVariableDeclaration(workerDeclaration) && workerDeclaration.pos > registration.pos
    ? workerDeclaration : undefined;
  const removal = unwrap(argument ?? work.arguments[0], budget);
  if (!ts.isCallExpression(removal) || removal.questionDotToken || removal.arguments.length
    || !ts.isPropertyAccessExpression(removal.expression) || removal.expression.questionDotToken
    || !/^(shift|pop)$/.test(removal.expression.name.text) || !ts.isIdentifier(removal.expression.expression)) return undefined;
  const receiver = removal.expression.expression;
  if (emptyCheck && symbolOf(emptyCheck) !== symbolOf(receiver)) return undefined;
  let bindingValue: ts.Expression | undefined = result;
  while (bindingValue && unwrapParent(bindingValue.parent) && bindingValue.parent.expression === bindingValue) {
    budget.take();
    bindingValue = bindingValue.parent;
  }
  const binding = bindingValue?.parent;
  const handle = binding && ts.isVariableDeclaration(binding) && ts.isIdentifier(binding.name)
    && (binding.parent.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) ? symbolOf(binding.name) : undefined;
  const mutableHandle = !!handle && !!(binding!.parent.flags & ts.NodeFlags.Let);
  return { receiver, emptyCheck, call: removal, timer, registration, worker: workerFunction,
    workerReference: ts.isIdentifier(worker) ? worker : undefined, nonemptyJob: nonemptyJob || !!emptyCheck,
    callbackReference, callbackDeclaration, handle, mutableHandle, lateWorker, available: true };
}

function onlyStatement(node: ts.Statement): ts.Statement | undefined {
  return ts.isBlock(node) ? node.statements.length === 1 ? node.statements[0] : undefined : node;
}

function exits(node: ts.Statement): boolean {
  const statement = onlyStatement(node);
  return !!statement && ts.isReturnStatement(statement) && !statement.expression;
}

function presentJob(test: ts.Expression, isJob: (node: ts.Expression) => boolean, budget: AnalysisBudget, excludesUndefined = false): boolean {
  const expr = unwrap(test, budget);
  if (isJob(expr)) return true;
  if (!ts.isBinaryExpression(expr) || ![ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(expr.operatorToken.kind)) return false;
  const other = unwrap(expr.right, budget);
  return isJob(expr.left) && (other.kind === ts.SyntaxKind.NullKeyword
    && (!excludesUndefined || expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken)
    || ts.isIdentifier(other) && other.text === "undefined" && !symbolOf(other)?.declarations?.length);
}

function workCall(node: ts.Node, budget: AnalysisBudget): ts.CallExpression | undefined {
  const expr = ts.isExpressionStatement(node) ? node.expression : ts.isReturnStatement(node) ? node.expression
    : ts.isExpression(node) ? node : undefined;
  if (!expr) return undefined;
  let work = unwrap(expr, budget);
  if (ts.isVoidExpression(work)) work = unwrap(work.expression, budget);
  return ts.isCallExpression(work) && !work.questionDotToken ? work : undefined;
}

function plainEnqueue(receiver: ts.Identifier): ts.CallExpression | undefined {
  const property = receiver.parent;
  if (!ts.isPropertyAccessExpression(property) || property.questionDotToken || property.expression !== receiver || property.name.text !== "push") return undefined;
  const call = property.parent;
  if (!ts.isCallExpression(call) || call.expression !== property || call.questionDotToken || call.arguments.length !== 1
    || ts.isSpreadElement(call.arguments[0])) return undefined;
  return call;
}

const QUEUE_READS = new Set(["at", "includes", "indexOf", "lastIndexOf"]);
function readOnlyQueueCall(receiver: ts.Identifier): boolean {
  const member = receiver.parent;
  if (!(ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member)) || member.expression !== receiver) return false;
  const name = ts.isPropertyAccessExpression(member) ? member.name.text
    : ts.isStringLiteralLike(member.argumentExpression) ? member.argumentExpression.text : undefined;
  return !!name && QUEUE_READS.has(name) && ts.isCallExpression(member.parent) && member.parent.expression === member;
}

function callOwner(call: ts.Node,
  cache: WeakMap<ts.Node, ts.SignatureDeclaration | null>, budget: AnalysisBudget): ts.SignatureDeclaration | undefined {
  const visited: ts.Node[] = [];
  let owner: ts.SignatureDeclaration | null = null;
  for (let node: ts.Node = call.parent; node; node = node.parent) {
    budget.take();
    const cached = cache.get(node);
    if (cached !== undefined) {
      owner = cached;
      break;
    }
    if (ts.isFunctionLike(node)) {
      owner = node;
      break;
    }
    visited.push(node);
  }
  for (const node of visited) cache.set(node, owner);
  return owner ?? undefined;
}

type AdmissionState = "open" | "guarded" | "resumed";
interface LoopWrites {
  bindings: Map<ts.Symbol, number[]>;
  evals: WeakMap<ts.SourceFile, number[]>;
  sorted: WeakSet<number[]>;
}

function addLoopWrite<T extends object>(index: { get(key: T): number[] | undefined; set(key: T, value: number[]): unknown },
  key: T, position: number): void {
  const positions = index.get(key);
  if (positions) positions.push(position);
  else index.set(key, [position]);
}

type AdmissionIndex = WeakMap<ts.Node, AdmissionFacts> & {
  loopWrites: LoopWrites;
  writtenNames: ReadonlySet<string>;
  booleanWrites: TimerWrites;
  globalAliases: WeakMap<ts.Symbol, boolean>;
  timerAliases: WeakMap<ts.Symbol, ts.Expression>;
  orderedBlocks: WeakMap<ts.Block, boolean>;
  booleanOrigins: WeakMap<ts.Symbol, BooleanOrigin | null>;
  booleanHelperWrites: TimerWrites;
  booleanNativeHelperWrites: TimerWrites;
  booleanOwnHelperWrites: WeakMap<ts.Node, TimerWrites>;
  booleanHelperReads: WeakMap<BooleanHelperRead, boolean>;
  booleanHelperShapes: WeakMap<ts.ObjectLiteralExpression, ReadonlySet<string> | null>;
  booleanHelperTargets: WeakSet<ts.Expression>;
  booleanReadPositions: WeakMap<ts.Node, number>;
  guardUnknownBoolean?: GuardProof;
  scalarOwnerCache: WeakMap<ts.Node, ts.SignatureDeclaration | null>;
  scalarUnitOwners?: (counter: ts.Symbol) => ReadonlySet<ts.SignatureDeclaration>;
  scalarCandidates: Set<ts.Symbol>;
  scalarRecords: Map<ts.Symbol, ScalarRecords>;
  scalarBoundedCounters: Set<ts.Symbol>;
  scalarBarrierMemo: WeakMap<ts.Expression, Map<number, ScalarBarrier | "always" | null>>;
  scalarAtoms: WeakMap<ts.Symbol, Map<string, ScalarBarrier>>;
  scalarCombinations: Map<"and" | "or", WeakMap<ScalarBarrier, WeakMap<ScalarBarrier, ScalarBarrier>>>;
  barrierSeen: WeakMap<ScalarCheck[], Map<string | ScalarBarrier, number>>;
  nativeQueueCall?: RequestReachability["nativeQueueCall"];
  guardExpressions: WeakMap<ts.Expression, ts.Expression>;
  guardNullish: WeakMap<ts.Expression, boolean | null>;
  guardTruth: WeakMap<ts.Expression, boolean | null>;
  guardBounds: WeakMap<ts.Symbol, Map<ts.Symbol | undefined, GuardBound>>;
  guardStartups: WeakMap<ts.Node, ts.Statement | null>;
  guardProofs: WeakMap<object, WeakMap<ts.Expression, Map<number, CachedGuardProof[]>>>;
  guardUnknownStartup: object;
  relevantCounters: ReadonlySet<ts.Symbol>;
  guardSharedProofs: WeakMap<ts.Expression, Map<number, GuardProof>>;
  capacityCache: CapacityCache;
  guardComparisons: WeakMap<GuardBound, GuardProof>;
  guardEmpty: readonly [GuardProof, GuardProof];
  guardMentions: readonly [WeakMap<ts.Symbol, GuardProof>, WeakMap<ts.Symbol, GuardProof>];
  guardCounterIds: Map<ts.Symbol, number>;
  guardMultipleMentions: Map<string, GuardProof>;
  guardCombinations: Map<number, WeakMap<GuardProof, WeakMap<GuardProof, GuardProof>>>;
  guardBooleanViews: WeakMap<GuardProof, GuardProof>;
  guardUncertainViews: WeakMap<GuardProof, GuardProof>;
  guardUntrustedViews: WeakMap<GuardProof, GuardProof>;
};

interface AdmissionFacts {
  state: AdmissionState;
  unreachable?: boolean;
  awaitEnds: number[];
  awaitStart?: number;
  // Earlier checks may be stale after a suspension or insufficient for an
  // unknown number of enqueues in a subsequent loop.
  lastSuspension: number;
  before?: number;
  capacityChecks?: Map<ts.Symbol, number[]>;
  capacityMentions?: Map<ts.Symbol, number[]>;
  uncertainCapacity?: Map<ts.Symbol, number[]>;
  scalarCapacity?: Map<ts.Symbol, number[]>;
  barrierChecks?: Map<ts.Symbol, ScalarCheck[]>;
  capacitySegment?: object;
  capacityGuards?: Map<ts.Symbol, Map<ts.Symbol, number[]>>;
  enclosing?: AdmissionFacts;
  async?: boolean;
  suspensionIndexed?: boolean;
  block?: AdmissionBlock;
}

interface AdmissionBlock {
  index: number;
  unreachable?: boolean;
  state: AdmissionState;
  lastSuspension: number;
  capacityChecks: Map<ts.Symbol, number[]>;
  capacityMentions: Map<ts.Symbol, number[]>;
  uncertainCapacity: Map<ts.Symbol, number[]>;
  scalarCapacity: Map<ts.Symbol, number[]>;
  barrierChecks: Map<ts.Symbol, ScalarCheck[]>;
  capacityGuards: Map<ts.Symbol, Map<ts.Symbol, number[]>>;
  appliedChecks: WeakSet<CapacityChecks>;
  capacitySegment: object;
}

interface QueueCounters {
  valid: Map<Queue, ts.Symbol>;
  invalid: Map<Queue, ts.Symbol>;
  reservations: WeakMap<ts.CallExpression, ts.Symbol>;
}

type ScalarOperator = "equal" | "different" | "less" | "atMost" | "more" | "atLeast" | "truthy" | "falsy";
interface ScalarBarrier {
  counter: ts.Symbol;
  operator: ScalarOperator | "and" | "or";
  limit?: number;
  left?: ScalarBarrier;
  right?: ScalarBarrier;
}
interface ScalarCheck { barrier: ScalarBarrier; position: number }
interface ScalarRecords {
  arrays: Map<number[], { uncertain: Map<ts.Symbol, number[]>; truthy: Set<number>; lastTruthy: number }>;
}

/** Equal formulas share identity; source positions remain on recorded checks so
 * a fresh check after suspension cannot reuse an earlier observation. */
function sharedScalarBarrier(barrier: ScalarBarrier, admission: AdmissionIndex, budget: AnalysisBudget): ScalarBarrier {
  budget.take();
  if (barrier.operator === "and" || barrier.operator === "or") {
    let combinations = admission.scalarCombinations.get(barrier.operator);
    if (!combinations) { combinations = new WeakMap(); admission.scalarCombinations.set(barrier.operator, combinations); }
    let rights = combinations.get(barrier.left!);
    if (!rights) { rights = new WeakMap(); combinations.set(barrier.left!, rights); }
    const prior = rights.get(barrier.right!);
    if (prior) return prior;
    rights.set(barrier.right!, barrier);
  } else {
    let atoms = admission.scalarAtoms.get(barrier.counter);
    if (!atoms) { atoms = new Map(); admission.scalarAtoms.set(barrier.counter, atoms); }
    const key = `${barrier.operator}:${barrier.limit}`;
    const prior = atoms.get(key);
    if (prior) return prior;
    atoms.set(key, barrier);
  }
  return barrier;
}

/** Only scalar gates need the additional queue-wide barrier proof. */
function scalarCandidate(expression: ts.Expression, budget: AnalysisBudget): ts.Symbol | undefined {
  let value = unwrap(expression, budget);
  while (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) {
    budget.take();
    value = unwrap(value.operand, budget);
  }
  if (!ts.isBinaryExpression(value)) return readCounter(value, budget);
  const operator = value.operatorToken.kind;
  if ([ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(operator)) {
    return readCounter(value.left, budget) ?? readCounter(value.right, budget);
  }
  // Rejecting small counts is not an upper bound. These policies can cooperate
  // with another route, so validate their common barrier instead of treating
  // their presence as generic admission.
  if (operator === ts.SyntaxKind.LessThanToken || operator === ts.SyntaxKind.LessThanEqualsToken) return readCounter(value.left, budget);
  if (operator === ts.SyntaxKind.GreaterThanToken || operator === ts.SyntaxKind.GreaterThanEqualsToken) return readCounter(value.right, budget);
  return undefined;
}

/** The global barrier only needs numeric counter predicates and their Boolean
 * combinations. Unknown operands contribute no guarantee for their outcome. */
function scalarBarrier(expression: ts.Expression, admission: AdmissionIndex, budget: AnalysisBudget,
  negated = false, after?: number): ScalarBarrier | undefined {
  type Proof = ScalarBarrier | "always" | undefined;
  // The low bit selects false; the high bit requires an actual Boolean value.
  // A truthy number cannot satisfy === true, but Boolean(number) can.
  type Visit = { kind: "visit"; expression: ts.Expression; mode: number; after?: number };
  type Task = Visit | { kind: "finish"; expression: ts.Expression; mode: number; after?: number }
    | { kind: "combine"; operator: "and" | "or" } | { kind: "select" };
  const pending: Task[] = [{ kind: "visit", expression, mode: negated ? 1 : 0, after }];
  const results: Proof[] = [];
  const active = Array.from({ length: 4 }, () => new WeakSet<ts.Expression>());
  // Filtered queries have one statement-local cutoff. Share their repeated
  // selector work without replacing the unrestricted expression cache.
  const filteredMemo = new WeakMap<ts.Expression, Map<number, ScalarBarrier | "always" | null>>();
  const combine = (left: Proof, right: Proof, operator: "and" | "or"): Proof => {
    if (operator === "and") {
      if (left === "always") return right;
      if (right === "always") return left;
      return left && right && left.counter === right.counter
        ? sharedScalarBarrier({ counter: left.counter, operator, left, right }, admission, budget) : undefined;
    }
    if (left === "always" || right === "always") return "always";
    if (!left || !right) return left ?? right;
    if (left.counter === right.counter) return sharedScalarBarrier({ counter: left.counter, operator, left, right }, admission, budget);
    return admission.relevantCounters.has(right.counter) && !admission.relevantCounters.has(left.counter) ? right : left;
  };
  while (pending.length) {
    budget.take();
    const task = pending.pop()!;
    if (task.kind === "finish") {
      const memo = task.after === undefined ? admission.scalarBarrierMemo : filteredMemo;
      let modes = memo.get(task.expression);
      if (!modes) { modes = new Map(); memo.set(task.expression, modes); }
      modes.set(task.mode, results[results.length - 1] ?? null);
      active[task.mode].delete(task.expression);
      continue;
    }
    if (task.kind === "combine") {
      const right = results.pop(), left = results.pop();
      results.push(combine(left, right, task.operator));
      continue;
    }
    if (task.kind === "select") {
      const no = results.pop(), yes = results.pop(), falsy = results.pop(), truthy = results.pop();
      // Both arms can supply a common barrier even when the selector is opaque.
      results.push(combine(combine(yes, no, "and"),
        combine(combine(truthy, yes, "and"), combine(falsy, no, "and"), "or"), "or"));
      continue;
    }
    if (task.after !== undefined && task.expression.pos >= task.after) task.after = undefined;
    const memo = task.after === undefined ? admission.scalarBarrierMemo : filteredMemo;
    const cached = memo.get(task.expression)?.get(task.mode);
    if (cached !== undefined) { results.push(cached ?? undefined); continue; }
    const visiting = active[task.mode];
    if (visiting.has(task.expression)) { results.push(undefined); continue; }
    visiting.add(task.expression);
    pending.push({ kind: "finish", expression: task.expression, mode: task.mode, after: task.after });
    const value = unwrap(task.expression, budget);
    const negative = !!(task.mode & 1), exact = !!(task.mode & 2);
    const truth = exact ? conditionBoolean(value, budget) : literalTruth(value, budget);
    if (truth !== undefined) { results.push(truth !== negative ? "always" : undefined); continue; }
    // An earlier operand remains a stale observation even though the complete
    // condition finishes after an await. Fresh helper calls clear this cutoff
    // before inspecting their lexically earlier function bodies.
    if (task.after !== undefined && value.end <= task.after) { results.push(undefined); continue; }
    if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) {
      pending.push({ ...task, expression: value.operand, mode: negative ? 0 : 1 });
      continue;
    }
    if (ts.isConditionalExpression(value)) {
      const selected = literalTruth(value.condition, budget);
      if (selected !== undefined) pending.push({ ...task, expression: selected ? value.whenTrue : value.whenFalse });
      else pending.push({ kind: "select" },
        { ...task, expression: value.whenFalse },
        { ...task, expression: value.whenTrue },
        { ...task, expression: value.condition, mode: 1 },
        { ...task, expression: value.condition, mode: 0 });
      continue;
    }
    if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      && (unwrap(value.right, budget).kind === ts.SyntaxKind.FalseKeyword || guardNullish(value.left, admission, budget) === false)) {
      // False preserves the left operand's truthiness. Exact-false queries
      // also accept nullish results, but the left's exact-false proof remains
      // a sound subset of those rejection states.
      pending.push({ ...task, expression: value.left });
      continue;
    }
    if (ts.isBinaryExpression(value) && (value.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      || value.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)) {
      const right = conditionBoolean(value.right, budget), left = conditionBoolean(value.left, budget);
      const literal = right ?? left;
      if (literal !== undefined) {
        const match = negative === (value.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken);
        pending.push({ ...task, expression: right !== undefined ? value.left : value.right,
          mode: match ? (literal ? 2 : 3) : (literal ? 1 : 0) });
        continue;
      }
    }
    if (ts.isBinaryExpression(value) && (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || value.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      const conjunction = value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken;
      if (!exact) pending.push({ kind: "combine", operator: conjunction !== negative ? "and" : "or" },
        { ...task, expression: value.right },
        { ...task, expression: value.left });
      else if (conjunction !== negative) pending.push({ kind: "combine", operator: "and" },
        { ...task, expression: value.right },
        { ...task, expression: value.left, mode: conjunction ? 0 : 1 });
      else pending.push({ kind: "combine", operator: "or" }, { kind: "combine", operator: "and" },
        { ...task, expression: value.right },
        { ...task, expression: value.left, mode: conjunction ? 0 : 1 },
        { ...task, expression: value.left });
      continue;
    }
    if (ts.isCallExpression(value)) {
      const coercion = booleanCoercion(value, admission, budget);
      if (coercion?.input.value && !coercion.input.unknown && !coercion.captured
        && nativeBooleanAt(coercion.origin, admission, budget) && nativeBooleanHelpers(coercion.origin, admission, budget)) {
        pending.push({ ...task, expression: coercion.input.value, mode: negative ? 1 : 0 });
        continue;
      }
      const helper = !coercion && admissionHelper(value, admission, budget);
      if (helper && helper.trusted) {
        pending.push({ ...task, expression: helper.condition });
        continue;
      }
    }
    let barrier: ScalarBarrier | undefined;
    if (!ts.isBinaryExpression(value) && !exact) {
      const counter = readCounter(value, budget);
      if (counter) barrier = { counter, operator: "truthy" };
    } else if (ts.isBinaryExpression(value)) {
      const operators: Partial<Record<ts.SyntaxKind, ScalarOperator>> = {
        [ts.SyntaxKind.EqualsEqualsToken]: "equal", [ts.SyntaxKind.EqualsEqualsEqualsToken]: "equal",
        [ts.SyntaxKind.ExclamationEqualsToken]: "different", [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "different",
        [ts.SyntaxKind.LessThanToken]: "less", [ts.SyntaxKind.LessThanEqualsToken]: "atMost",
        [ts.SyntaxKind.GreaterThanToken]: "more", [ts.SyntaxKind.GreaterThanEqualsToken]: "atLeast",
      };
      let operator = operators[value.operatorToken.kind];
      let counter = readCounter(value.left, budget), limit = value.right;
      if (!counter) {
        counter = readCounter(value.right, budget);
        limit = value.left;
        if (operator) operator = ({ less: "more", more: "less", atMost: "atLeast", atLeast: "atMost" } as Partial<Record<ScalarOperator, ScalarOperator>>)[operator] ?? operator;
      }
      const numeric = counter && operator ? singletonLoopValue(initializedAlias(limit, admission.timerAliases, budget), budget) : undefined;
      if (counter && operator && numeric !== undefined && Number.isFinite(numeric)) barrier = { counter, operator, limit: numeric };
    }
    if (barrier && negative) {
      const inverse: Record<ScalarOperator, ScalarOperator> = {
        equal: "different", different: "equal", less: "atLeast", atLeast: "less",
        more: "atMost", atMost: "more", truthy: "falsy", falsy: "truthy",
      };
      barrier = { ...barrier, operator: inverse[barrier.operator as ScalarOperator] };
    }
    results.push(barrier ? sharedScalarBarrier(barrier, admission, budget) : undefined);
  }
  const result = results.pop();
  return result === "always" ? undefined : result;
}

type CounterRange = readonly [number, number];
type CounterRanges = readonly CounterRange[];
const noCounterValues: CounterRanges = [];
const allCounterValues: CounterRanges = [[Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]];

/** Sorted, disjoint integer intervals compactly represent every candidate cap.
 * Combining paths must charge interval work, but never replay the caller graph
 * once per numeric threshold. */
function combineCounterRanges(left: CounterRanges, right: CounterRanges, union: boolean, budget: AnalysisBudget): CounterRanges {
  budget.take();
  if (left === right) return left;
  if (union) {
    if (!left.length || right === allCounterValues) return right;
    if (!right.length || left === allCounterValues) return left;
  } else {
    if (!left.length || right === allCounterValues) return left;
    if (!right.length || left === allCounterValues) return right;
  }
  const result: [number, number][] = [];
  let first = 0, second = 0;
  if (union) {
    while (first < left.length || second < right.length) {
      budget.take();
      const next = second >= right.length || first < left.length && left[first][0] <= right[second][0]
        ? left[first++] : right[second++];
      const previous = result[result.length - 1];
      if (previous && next[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], next[1]);
      else result.push([next[0], next[1]]);
    }
  } else {
    while (first < left.length && second < right.length) {
      budget.take();
      const start = Math.max(left[first][0], right[second][0]);
      const end = Math.min(left[first][1], right[second][1]);
      if (start <= end) result.push([start, end]);
      if (left[first][1] <= right[second][1]) first++;
      else second++;
    }
  }
  return result.length ? result : noCounterValues;
}

function scalarRejectionRanges(check: ScalarBarrier, budget: AnalysisBudget,
  memo: WeakMap<ScalarBarrier, CounterRanges>): CounterRanges {
  const interval = (start: number, end: number): CounterRanges => {
    const low = Math.max(Number.MIN_SAFE_INTEGER, start), high = Math.min(Number.MAX_SAFE_INTEGER, end);
    return low > high ? noCounterValues : low === Number.MIN_SAFE_INTEGER && high === Number.MAX_SAFE_INTEGER
      ? allCounterValues : [[low, high]];
  };
  const pending = [check];
  while (pending.length) {
    budget.take();
    const current = pending[pending.length - 1];
    if (memo.has(current)) { pending.pop(); continue; }
    let rejected: CounterRanges;
    if (current.operator === "and" || current.operator === "or") {
      const left = memo.get(current.left!), right = memo.get(current.right!);
      if (!left) { pending.push(current.left!); continue; }
      if (!right) { pending.push(current.right!); continue; }
      rejected = combineCounterRanges(left, right, current.operator === "or", budget);
    } else switch (current.operator) {
      case "equal": rejected = Number.isSafeInteger(current.limit) ? interval(current.limit!, current.limit!) : noCounterValues; break;
      case "different": rejected = Number.isSafeInteger(current.limit)
        ? combineCounterRanges(interval(-Infinity, current.limit! - 1), interval(current.limit! + 1, Infinity), true, budget)
        : allCounterValues; break;
      case "less": rejected = interval(-Infinity, Math.ceil(current.limit!) - 1); break;
      case "atMost": rejected = interval(-Infinity, Math.floor(current.limit!)); break;
      case "more": rejected = interval(Math.floor(current.limit!) + 1, Infinity); break;
      case "atLeast": rejected = interval(Math.ceil(current.limit!), Infinity); break;
      case "truthy": rejected = [[Number.MIN_SAFE_INTEGER, -1], [1, Number.MAX_SAFE_INTEGER]]; break;
      case "falsy": rejected = [[0, 0]]; break;
    }
    memo.set(current, rejected!);
    pending.pop();
  }
  return memo.get(check)!;
}

/** Scalar equality is useful only when an invocation cannot skip over the
 * checked count. Separate request roots are independent unit invocations. */
function scalarUnitOwners(queues: ReadonlyArray<[Queue, ts.Symbol]>, requests: RequestReachability,
  ownerCache: WeakMap<ts.Node, ts.SignatureDeclaration | null>, budget: AnalysisBudget):
  (counter: ts.Symbol) => ReadonlySet<ts.SignatureDeclaration> {
  const byCounter = new Map<ts.Symbol, Queue>();
  for (const [queue, counter] of queues) { budget.take(); byCounter.set(counter, queue); }
  const cache = new Map<Queue | undefined, ReadonlySet<ts.SignatureDeclaration>>();
  return counter => {
    const queue = byCounter.get(counter);
    const cached = cache.get(queue);
    if (cached) return cached;
    const unit = new Set<ts.SignatureDeclaration>();
    cache.set(queue, unit);
    if (!queue) return unit;
    type Owner = { sites: Set<ts.Node>; children: Set<ts.SignatureDeclaration>; parents: Set<ts.SignatureDeclaration>; repeated: boolean };
    const owners = new Map<ts.SignatureDeclaration, Owner>();
    const pending: ts.SignatureDeclaration[] = [];
    const entry = (fn: ts.SignatureDeclaration): Owner => {
      let owner = owners.get(fn);
      if (!owner) {
        owner = { sites: new Set(), children: new Set(), parents: new Set(), repeated: false };
        owners.set(fn, owner);
        pending.push(fn);
      }
      return owner;
    };
    const repeated = (site: ts.Node, fn: ts.SignatureDeclaration): boolean => {
      for (let node = site.parent; node && node !== fn; node = node.parent) {
        budget.take();
        if (ts.isIterationStatement(node, false)) return true;
      }
      return false;
    };
    for (const producer of queue.producers) {
      budget.take();
      if (requests.evidence(producer) !== "request") continue;
      const fn = callOwner(producer, ownerCache, budget);
      if (!fn) continue;
      const owner = entry(fn);
      owner.sites.add(producer);
      owner.repeated ||= repeated(producer, fn);
    }
    while (pending.length) {
      budget.take();
      const fn = pending.pop()!;
      const owner = owners.get(fn)!;
      for (const [caller, batch] of requests.queueCallers(fn) ?? []) {
        budget.take();
        if (!caller) continue;
        const parent = callOwner(caller, ownerCache, budget);
        if (!parent) continue;
        const incoming = entry(parent);
        incoming.sites.add(caller);
        incoming.children.add(fn);
        owner.parents.add(parent);
        incoming.repeated ||= batch !== false || !requests.unitQueueCaller(fn, caller) || repeated(caller, parent);
      }
    }
    const remaining = new Map<ts.SignatureDeclaration, number>();
    for (const [fn, owner] of owners) {
      budget.take();
      remaining.set(fn, owner.children.size);
      if (!owner.children.size) pending.push(fn);
    }
    while (pending.length) {
      budget.take();
      const fn = pending.pop()!, owner = owners.get(fn)!;
      if (!owner.repeated && owner.sites.size <= 1) unit.add(fn);
      for (const parent of owner.parents) {
        budget.take();
        const incoming = owners.get(parent)!;
        incoming.repeated ||= !unit.has(fn);
        const rest = remaining.get(parent)! - 1;
        remaining.set(parent, rest);
        if (!rest) pending.push(parent);
      }
    }
    // Cycles retain unresolved children and never acquire a unit proof.
    return unit;
  };
}

/** Equality is a queue-wide invariant: another producer must not move the
 * counter across the value at which this producer stops admitting work. */
function prepareScalarAdmission(queues: ReadonlyArray<[Queue, ts.Symbol]>, requests: RequestReachability,
  admission: AdmissionIndex, reservations: WeakMap<ts.CallExpression, ts.Symbol>, budget: AnalysisBudget): void {
  const selected = new Map<ts.Symbol, Queue>();
  for (const [queue, counter] of queues) {
    budget.take();
    if (admission.scalarCandidates.has(counter)) selected.set(counter, queue);
  }
  if (!selected.size) return;
  type Site = ts.CallExpression | ts.NewExpression;
  const factsBySite = new WeakMap<Site, AdmissionFacts | null>();
  const pending: ts.SignatureDeclaration[] = [];
  const visited = new Set<ts.SignatureDeclaration>();
  const include = (site: Site): void => {
    if (factsBySite.has(site)) return;
    budget.take();
    factsBySite.set(site, callAdmission(site, admission, budget) ?? null);
    const owner = callOwner(site, admission.scalarOwnerCache, budget);
    if (owner) pending.push(owner);
  };
  for (const queue of selected.values()) for (const producer of queue.producers) {
    budget.take();
    if (requests.evidence(producer) === "request") include(producer);
  }
  // This first pass records provisional scalar evidence without consuming the
  // admission cache. Shared helpers and sites are indexed once for all queues.
  while (pending.length) {
    budget.take();
    const fn = pending.pop()!;
    if (visited.has(fn)) continue;
    visited.add(fn);
    for (const [caller] of requests.queueCallers(fn) ?? []) {
      budget.take();
      if (caller) include(caller);
    }
  }
  for (const [counter, queue] of selected) {
    budget.take();
    const records = admission.scalarRecords.get(counter);
    if (!records) continue;
    const unit = admission.scalarUnitOwners!(counter);
    const initial = initialCounter(counter, budget);
    const rejectionCache = new WeakMap<ScalarBarrier, CounterRanges>();
    type LocalBarrier = { ranges: CounterRanges; inherit: boolean; owner?: ts.SignatureDeclaration };
    const localBarriers = new WeakMap<object, LocalBarrier>();
    const missing: LocalBarrier = { ranges: noCounterValues, inherit: false };
    const unreachable: LocalBarrier = { ranges: allCounterValues, inherit: false };
    const available = (site: Site): LocalBarrier => {
      const facts = ts.isCallExpression(site) && reservations.get(site) === counter
        ? callAdmission(site, admission, budget, site.pos) : factsBySite.get(site);
      if (!facts) return missing;
      if (facts.unreachable) return unreachable;
      const key = facts.capacitySegment ?? facts;
      const cached = localBarriers.get(key);
      if (cached) return cached;
      const owner = callOwner(site, admission.scalarOwnerCache, budget);
      let ranges = noCounterValues;
      if (owner && unit.has(owner)) {
        for (let scope: AdmissionFacts | undefined = facts; scope; scope = scope.enclosing) {
          budget.take();
          if (scope.before === undefined) continue;
          for (const check of scope.barrierChecks?.get(counter) ?? []) {
            budget.take();
            if (check.position >= scope.before) break;
            if (check.position > facts.lastSuspension) ranges = combineCounterRanges(ranges,
              scalarRejectionRanges(check.barrier, budget, rejectionCache), true, budget);
          }
        }
      }
      const result: LocalBarrier = { ranges, inherit: facts.state !== "resumed" && !!owner, owner: owner ?? undefined };
      localBarriers.set(key, result);
      return result;
    };
    const owners = new WeakMap<ts.SignatureDeclaration, CounterRanges>();
    const active = new WeakSet<ts.SignatureDeclaration>();
    // Intersect all incoming paths once. A function's result is the set of
    // counts at which every caller prevents entry, rather than one Boolean per
    // candidate threshold. Cyclic/unknown edges contribute no inherited proof.
    const inherited = (start: ts.SignatureDeclaration): CounterRanges => {
      const known = owners.get(start);
      if (known) return known;
      type Frame = { fn: ts.SignatureDeclaration; ranges: CounterRanges;
        edges: Iterator<[Site | null, boolean | "deferred" | ts.Expression]>; waiting?: LocalBarrier };
      const stack: Frame[] = [];
      const enter = (fn: ts.SignatureDeclaration): void => {
        const edges = requests.queueCallers(fn);
        if (!edges?.size) { owners.set(fn, noCounterValues); return; }
        active.add(fn);
        stack.push({ fn, ranges: allCounterValues, edges: edges.entries() });
      };
      enter(start);
      while (stack.length) {
        budget.take();
        const frame = stack[stack.length - 1];
        if (frame.waiting) {
          const local = frame.waiting;
          frame.waiting = undefined;
          frame.ranges = combineCounterRanges(frame.ranges,
            combineCounterRanges(local.ranges, owners.get(local.owner!) ?? noCounterValues, true, budget), false, budget);
        }
        const edge = frame.ranges.length ? frame.edges.next() : { done: true as const };
        if (edge.done) {
          owners.set(frame.fn, frame.ranges);
          active.delete(frame.fn);
          stack.pop();
          continue;
        }
        const [caller, batch] = edge.value;
        if (caller && factsBySite.get(caller)?.unreachable) continue;
        // A repeated/deferred callback cannot inherit an outer scalar gate.
        if (!caller || batch !== false || !requests.unitQueueCaller(frame.fn, caller)) {
          frame.ranges = noCounterValues;
          continue;
        }
        const local = available(caller);
        if (local.ranges === allCounterValues) continue;
        if (!local.inherit || !local.owner || active.has(local.owner)) {
          frame.ranges = combineCounterRanges(frame.ranges, local.ranges, false, budget);
          continue;
        }
        const incoming = owners.get(local.owner);
        if (incoming) frame.ranges = combineCounterRanges(frame.ranges,
          combineCounterRanges(local.ranges, incoming, true, budget), false, budget);
        else { frame.waiting = local; enter(local.owner); }
      }
      return owners.get(start) ?? noCounterValues;
    };
    let common = initial === undefined ? noCounterValues : allCounterValues;
    for (const producer of queue.producers) {
      budget.take();
      if (!common.length) break;
      if (requests.evidence(producer) !== "request") continue;
      const local = available(producer);
      const ranges = local.inherit && local.owner
        ? combineCounterRanges(local.ranges, inherited(local.owner), true, budget) : local.ranges;
      common = combineCounterRanges(common, ranges, false, budget);
    }
    const bounded = common.some(([, end]) => { budget.take(); return end >= initial!; });
    if (bounded) { admission.scalarBoundedCounters.add(counter); continue; }
    // Remove only the provisional scalar proof. Preserve ordinary relational
    // evidence, and prevent the generic admission heuristic rescuing a failed
    // equality policy on another route.
    for (const [positions, { uncertain, truthy }] of records.arrays) {
      budget.take();
      let marked = uncertain.get(counter);
      if (!marked) { marked = []; uncertain.set(counter, marked); }
      let retained = 0;
      for (const position of positions) {
        budget.take();
        // A truthiness gate admits only at zero. Unlike equality at a positive
        // limit, another producer cannot move past it into an admitted region.
        if (truthy.has(position)) positions[retained++] = position;
        else marked.push(position);
      }
      marked.sort((left, right) => { budget.take(); return left - right; });
      positions.length = retained;
    }
  }
}

function queueCounters(queues: Queue[], requests: RequestReachability, workspace: Workspace, budget: AnalysisBudget): QueueCounters {
  const statementIndices = new WeakMap<ts.Statement, number>();
  const indexed = new WeakSet<ts.Block>();
  const counters = new Map<Queue, ts.Symbol>();
  const reservations = new WeakMap<ts.CallExpression, ts.Symbol>();
  const allowedWrites = new WeakSet<ts.Node>();
  const incrementAt = (statement?: ts.Statement): { counter: ts.Symbol; update: ts.Expression } | undefined => {
    if (!statement || !ts.isExpressionStatement(statement)) return undefined;
    const update = unwrap(statement.expression, budget);
    const counter = counterUpdate(update, true, budget);
    return counter && { counter, update };
  };
  for (const queue of queues) {
    // Producers are collected by a right-to-left AST walk. Prefer the following
    // increment, leaving the preceding reservation available to the earlier
    // producer. One counter write can account for only one push.
    let matches: Map<ts.Symbol, { writes: Set<ts.Expression>; reserved: ts.CallExpression[] }> | undefined;
    for (const push of queue.producers) {
      budget.take();
      if (requests.evidence(push) !== "request") continue;
      let expression: ts.Expression = push;
      while (unwrapParent(expression.parent)) { budget.take(); expression = expression.parent; }
      const statement = expression.parent;
      if (!ts.isExpressionStatement(statement) || !ts.isBlock(statement.parent)) { matches = undefined; break; }
      const block = statement.parent;
      if (!indexed.has(block)) {
        indexed.add(block);
        for (let i = 0; i < block.statements.length; i++) {
          budget.take();
          statementIndices.set(block.statements[i], i);
        }
      }
      const index = statementIndices.get(statement)!;
      const next = incrementAt(block.statements[index + 1]);
      const previous = incrementAt(block.statements[index - 1]);
      if (!matches) {
        matches = new Map();
        if (next) matches.set(next.counter, { writes: new Set(), reserved: [] });
        if (previous && !matches.has(previous.counter)) matches.set(previous.counter, { writes: new Set(), reserved: [] });
      }
      for (const [counter, match] of matches) {
        budget.take();
        if (next?.counter === counter && !match.writes.has(next.update)) match.writes.add(next.update);
        else if (previous?.counter === counter && !match.writes.has(previous.update)) {
          match.writes.add(previous.update); match.reserved.push(push);
        }
        else matches.delete(counter);
      }
      if (!matches.size) break;
    }
    if (matches?.size) {
      const [counter, { writes, reserved }] = matches.entries().next().value!;
      counters.set(queue, counter);
      for (const write of writes) { budget.take(); allowedWrites.add(write); }
      for (const push of reserved) { budget.take(); reservations.set(push, counter); }
    }
  }
  const invalidCounters = new Map<Queue, ts.Symbol>();
  if (!counters.size) return { valid: counters, invalid: invalidCounters, reservations };
  const symbols = new Set(counters.values());
  const names = new Set([...symbols].map(symbol => symbol.name));
  const invalid = new Set<ts.Symbol>();
  const distinct = new Set<ts.Symbol>();
  const workerCounters = new Map<ts.Symbol, Set<ts.Symbol>>();
  const workerNames = new Set<string>();
  const workerReferences = new WeakSet<ts.Identifier>();
  for (const [queue, counter] of counters) {
    budget.take();
    const declaration = counter.valueDeclaration;
    const initial = declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
      ? unwrap(declaration.initializer, budget) : undefined;
    const magnitude = initial && ts.isPrefixUnaryExpression(initial)
      && (initial.operator === ts.SyntaxKind.PlusToken || initial.operator === ts.SyntaxKind.MinusToken)
      ? unwrap(initial.operand, budget) : initial;
    // An increment can fail to advance a non-finite or imprecise Number.
    if (!magnitude || !ts.isNumericLiteral(magnitude) || !Number.isSafeInteger(Number(magnitude.text))) invalid.add(counter);
    if (distinct.has(counter)) invalid.add(counter);
    distinct.add(counter);
    const drain = queue.drain!;
    const decrement = guardedWorkerDecrement(drain, counter, budget);
    if (decrement) {
      allowedWrites.add(decrement);
      const reference = drain.workerReference;
      const symbol = reference && symbolOf(reference);
      if (reference && symbol) {
        const affected = workerCounters.get(symbol) ?? new Set<ts.Symbol>();
        affected.add(counter);
        workerCounters.set(symbol, affected);
        workerNames.add(reference.text);
        workerReferences.add(reference);
        const declaration = symbol.valueDeclaration;
        const name = declaration && (ts.isVariableDeclaration(declaration) || ts.isFunctionDeclaration(declaration)) ? declaration.name : undefined;
        if (name && ts.isIdentifier(name)) workerReferences.add(name);
      }
    }
  }
  const visitedTargets = new WeakSet<ts.Expression>();
  for (const { sf } of workspace.units) {
    const pending: ts.Node[] = [sf];
    while (pending.length) {
      budget.take();
      const node = pending.pop()!;
      if (ts.isIdentifier(node) && workerNames.has(node.text) && !workerReferences.has(node)) {
        const symbol = referenceSymbol(node);
        if (symbol) for (const counter of workerCounters.get(symbol) ?? []) { budget.take(); invalid.add(counter); }
      }
      const target = writeTarget(node);
      if (target && !allowedWrites.has(node)) {
        const targets = [target];
        while (targets.length) {
          budget.take();
          const target = targets.pop()!;
          if (visitedTargets.has(target)) continue;
          visitedTargets.add(target);
          if (ts.isIdentifier(target) && names.has(target.text)) {
            const symbol = ts.isShorthandPropertyAssignment(target.parent)
              ? checkerFor(sf).getShorthandAssignmentValueSymbol(target.parent) : symbolOf(target);
            if (symbol && symbols.has(symbol)) invalid.add(symbol);
          } else if (unwrapParent(target) || ts.isSpreadElement(target)) targets.push(target.expression);
          else if (ts.isArrayLiteralExpression(target)) for (const item of target.elements) targets.push(item);
          else if (ts.isObjectLiteralExpression(target)) {
            for (const property of target.properties) {
              if (ts.isPropertyAssignment(property)) targets.push(property.initializer);
              else if (ts.isShorthandPropertyAssignment(property)) targets.push(property.name);
              else if (ts.isSpreadAssignment(property)) targets.push(property.expression);
            }
          } else if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) targets.push(target.left);
        }
      }
      ts.forEachChild(node, child => { pending.push(child); });
    }
  }
  for (const [queue, counter] of counters) {
    budget.take();
    if (!invalid.has(counter)) continue;
    invalidCounters.set(queue, counter);
    counters.delete(queue);
  }
  return { valid: counters, invalid: invalidCounters, reservations };
}

function guardedWorkerDecrement(drain: Drain, counter: ts.Symbol, budget: AnalysisBudget): ts.Expression | undefined {
  const { worker } = drain;
  if (!worker.body) return undefined;
  const body = ts.isBlock(worker.body) ? worker.body.statements[0] : worker.body;
  let decrement: ts.Node | undefined = body;
  if (body && ts.isIfStatement(body) && !body.elseStatement) {
    const parameter = worker.parameters[0];
    const job = parameter && !parameter.initializer && ts.isIdentifier(parameter.name) ? symbolOf(parameter.name) : undefined;
    if (!job) return undefined;
    const isJob = (expression: ts.Expression): boolean => {
      const checked = unwrap(expression, budget);
      return ts.isIdentifier(checked) && symbolOf(checked) === job;
    };
    if (presentJob(body.expression, isJob, budget, true)) {
      decrement = ts.isBlock(body.thenStatement) ? body.thenStatement.statements[0] : body.thenStatement;
    } else {
      const guard = unwrap(body.expression, budget);
      const absent = ts.isPrefixUnaryExpression(guard) && guard.operator === ts.SyntaxKind.ExclamationToken && isJob(guard.operand)
        || ts.isBinaryExpression(guard) && isJob(guard.left)
          && (guard.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken || guard.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken)
          && (ts.isIdentifier(guard.right) && guard.right.text === "undefined" && hostIdentifier(guard.right)
            || guard.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken && guard.right.kind === ts.SyntaxKind.NullKeyword);
      const exit = onlyStatement(body.thenStatement);
      if (!absent || !exit || !ts.isReturnStatement(exit) || !ts.isBlock(worker.body)) return undefined;
      decrement = worker.body.statements[1];
    }
  } else if (!drain.nonemptyJob) return undefined;
  const expression = decrement && (ts.isExpressionStatement(decrement) ? decrement.expression : ts.isExpression(decrement) ? decrement : undefined);
  if (!expression) return undefined;
  const update = unwrap(expression, budget);
  return counterUpdate(update, false, budget) === counter ? update : undefined;
}

function counterUpdate(update: ts.Expression, increment: boolean, budget: AnalysisBudget): ts.Symbol | undefined {
  if (ts.isPrefixUnaryExpression(update) || ts.isPostfixUnaryExpression(update)) {
    return update.operator === (increment ? ts.SyntaxKind.PlusPlusToken : ts.SyntaxKind.MinusMinusToken)
      ? mutableCounter(update.operand, budget) : undefined;
  }
  if (!ts.isBinaryExpression(update)) return undefined;
  const counter = mutableCounter(update.left, budget);
  if (!counter) return undefined;
  const right = unwrap(update.right, budget);
  if (update.operatorToken.kind === (increment ? ts.SyntaxKind.PlusEqualsToken : ts.SyntaxKind.MinusEqualsToken)) {
    return ts.isNumericLiteral(right) && Number(right.text) === 1 ? counter : undefined;
  }
  if (update.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isBinaryExpression(right)
    || right.operatorToken.kind !== (increment ? ts.SyntaxKind.PlusToken : ts.SyntaxKind.MinusToken)
    || mutableCounter(right.left, budget) !== counter) return undefined;
  const amount = unwrap(right.right, budget);
  return ts.isNumericLiteral(amount) && Number(amount.text) === 1 ? counter : undefined;
}

function literalNullish(node: ts.Expression, budget: AnalysisBudget): boolean | undefined {
  const expression = unwrap(node, budget);
  if (expression.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(expression)
    || ts.isIdentifier(expression) && expression.text === "undefined" && hostIdentifier(expression)) return true;
  if (expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword
    || ts.isNumericLiteral(expression) || ts.isBigIntLiteral(expression) || ts.isStringLiteralLike(expression)
    || ts.isArrayLiteralExpression(expression) || ts.isObjectLiteralExpression(expression)) return false;
  return conditionNullish(expression, budget);
}

/** Find the evaluated receiver of a definitely short-circuited optional chain. */
function skippedOptionalReceiver(node: ts.OptionalChain, memo: WeakMap<ts.OptionalChain, ts.Expression | null>,
  budget: AnalysisBudget): ts.Expression | undefined {
  let current = node;
  const pending: ts.OptionalChain[] = [];
  while (true) {
    budget.take();
    if (memo.has(current)) break;
    pending.push(current);
    if (!ts.isOptionalChain(current.expression)) break;
    current = current.expression;
  }
  let receiver = memo.get(current) ?? undefined;
  while (pending.length) {
    budget.take();
    const part = pending.pop()!;
    if (!receiver && !ts.isNonNullExpression(part) && part.questionDotToken
      && literalNullish(part.expression, budget) === true) receiver = part.expression;
    memo.set(part, receiver ?? null);
  }
  return receiver;
}

const NORMAL_COMPLETION = 1;
const BREAK_COMPLETION = 2;
const CONTINUE_COMPLETION = 4;
const EXIT_COMPLETION = 8;
const LABELED_BREAK_COMPLETION = 16;
const LABELED_CONTINUE_COMPLETION = 32;
const THROW_COMPLETION = 64;
const ANY_COMPLETION = NORMAL_COMPLETION | BREAK_COMPLETION | CONTINUE_COMPLETION | EXIT_COMPLETION
  | LABELED_BREAK_COMPLETION | LABELED_CONTINUE_COMPLETION | THROW_COMPLETION;

type LabelTargets = WeakMap<ts.Node, Map<string, ts.Statement | null>>;
const admissionLabelTargets = new WeakMap<AnalysisBudget, LabelTargets>();

function labelTarget(jump: ts.BreakOrContinueStatement, budget: AnalysisBudget): ts.Statement | null {
  let targets = admissionLabelTargets.get(budget);
  if (!targets) { targets = new WeakMap(); admissionLabelTargets.set(budget, targets); }
  const name = jump.label!.text;
  const traversed: ts.Node[] = [];
  let target: ts.Statement | null = null;
  for (let scope: ts.Node | undefined = jump.parent; scope && !ts.isFunctionLike(scope); scope = scope.parent) {
    budget.take();
    const cached = targets.get(scope)?.get(name);
    if (cached !== undefined) { target = cached; break; }
    traversed.push(scope);
    if (ts.isLabeledStatement(scope) && scope.label.text === name) {
      let statement = scope.statement;
      while (ts.isLabeledStatement(statement)) { budget.take(); statement = statement.statement; }
      target = statement;
      break;
    }
  }
  for (const scope of traversed) {
    budget.take();
    let labels = targets.get(scope);
    if (!labels) { labels = new Map(); targets.set(scope, labels); }
    labels.set(name, target);
  }
  return target;
}

const admissionBlockStatements = new WeakMap<AnalysisBudget, WeakMap<ts.Block, readonly ts.Statement[]>>();

/** Share the flow-relevant part of a block when several enclosing loops query it. */
function flowStatements(block: ts.Block, budget: AnalysisBudget): readonly ts.Statement[] {
  let cache = admissionBlockStatements.get(budget);
  if (!cache) { cache = new WeakMap(); admissionBlockStatements.set(budget, cache); }
  const cached = cache.get(block);
  if (cached) return cached;
  const relevant: ts.Statement[] = [];
  for (const statement of block.statements) {
    if (hasFlowEffect(statement, budget)) relevant.push(statement);
  }
  cache.set(block, relevant);
  return relevant;
}

function awaitUsing(node: ts.Node): boolean {
  return ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing;
}

/** Plain reads and branches with no modeled suspension or abrupt exit have no flow effect. */
function hasFlowEffect(statement: ts.Statement, budget: AnalysisBudget): boolean {
  const pending: ts.Node[] = [statement];
  while (pending.length) {
    budget.take();
    const node = pending.pop()!;
    if (ts.isFunctionLike(node) || ts.isEmptyStatement(node)) continue;
    // A block has its own shared projection. Its parent need not scan it first.
    if (node === statement && ts.isBlock(node)) return true;
    if (ts.isAwaitExpression(node) || awaitUsing(node)) return true;
    if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
      const condition = ts.isIfStatement(node) ? node.expression : node.condition;
      const yes = ts.isIfStatement(node) ? node.thenStatement : node.whenTrue;
      const no = ts.isIfStatement(node) ? node.elseStatement : node.whenFalse;
      const truth = literalTruth(condition, budget);
      pending.push(condition);
      if (truth !== false) pending.push(yes);
      if (truth !== true && no) pending.push(no);
      continue;
    }
    if (ts.isStatement(node) && skippedAdmissionLoop(node, budget)) {
      if (ts.isForOfStatement(node)) {
        if (node.awaitModifier) return true;
        pending.push(node.expression);
      }
      if (ts.isForStatement(node) && node.initializer) pending.push(node.initializer);
      if (ts.isWhileStatement(node)) pending.push(node.expression);
      else if (ts.isForStatement(node) && node.condition) pending.push(node.condition);
      continue;
    }
    if (ts.isSwitchStatement(node)) {
      pending.push(node.expression);
      const dispatch = switchDispatch(node, budget);
      for (const test of dispatch.tests) { budget.take(); pending.push(test); }
      // The neutral, common form ends each case with a direct break. An
      // unclassified statement may fall through, so retain subsequent clauses.
      let flowing = false;
      for (const clause of node.caseBlock.clauses) {
        budget.take();
        if (!flowing && !dispatch.direct.has(clause)) continue;
        flowing = true;
        for (const child of clause.statements) {
          budget.take();
          if (ts.isBreakStatement(child) && !child.label) { flowing = false; break; }
          pending.push(child);
        }
      }
      continue;
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken
        || operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) {
        pending.push(node.left);
        const skipsRight = operator === ts.SyntaxKind.QuestionQuestionToken
          ? literalNullish(node.left, budget) === false
          : literalTruth(node.left, budget) === (operator === ts.SyntaxKind.BarBarToken);
        if (!skipsRight) pending.push(node.right);
        continue;
      }
    }
    if (ts.isBreakStatement(node) && !node.label) {
      // Breaks contained by a switch in this projection do not leave it.
      if (node === statement) return true;
      for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
        budget.take();
        if (ts.isSwitchStatement(scope)) break;
        if (scope === statement || ts.isIterationStatement(scope, false)) return true;
      }
      continue;
    }
    if (ts.isStatement(node) && !ts.isBlock(node) && !ts.isIfStatement(node)
      && !ts.isLabeledStatement(node) && !ts.isTryStatement(node) && !ts.isSwitchStatement(node)
      && !ts.isExpressionStatement(node) && !ts.isVariableStatement(node)) return true;
    ts.forEachChild(node, child => { pending.push(child); });
  }
  return false;
}

type StatementOutcomes = {
  mask: number;
  breaks?: ReadonlySet<ts.Statement>;
  continues?: ReadonlySet<ts.Statement>;
};

function mergeTargets(into: Set<ts.Statement>, targets: ReadonlySet<ts.Statement> | undefined,
  budget: AnalysisBudget, excluding?: ts.Statement): void {
  for (const target of targets ?? []) { budget.take(); if (target !== excluding) into.add(target); }
}

function outcomes(mask: number, breaks: ReadonlySet<ts.Statement>, continues: ReadonlySet<ts.Statement>): StatementOutcomes {
  return { mask: (mask & ~(LABELED_BREAK_COMPLETION | LABELED_CONTINUE_COMPLETION))
    | (breaks.size ? LABELED_BREAK_COMPLETION : 0) | (continues.size ? LABELED_CONTINUE_COMPLETION : 0),
    breaks: breaks.size ? breaks : undefined, continues: continues.size ? continues : undefined };
}

function loopCondition(loop: ts.IterationStatement): ts.Expression | undefined {
  return ts.isForStatement(loop) ? loop.condition
    : ts.isWhileStatement(loop) || ts.isDoStatement(loop) ? loop.expression : undefined;
}

function labeledBody(statement: ts.LabeledStatement, budget: AnalysisBudget): ts.Statement {
  let body = statement.statement;
  while (ts.isLabeledStatement(body)) { budget.take(); body = body.statement; }
  return body;
}

const completionMemos = new WeakMap<AnalysisBudget, WeakMap<ts.Statement, StatementOutcomes>>();

function statementCompletions(node: ts.Statement, budget: AnalysisBudget): StatementOutcomes {
  let memo = completionMemos.get(budget);
  if (!memo) { memo = new WeakMap(); completionMemos.set(budget, memo); }
  const pending = [{ node, expanded: false }];
  while (pending.length) {
    budget.take();
    const { node: statement, expanded } = pending.pop()!;
    if (memo.has(statement)) continue;
    if (ts.isIterationStatement(statement, false)) {
      const condition = loopCondition(statement);
      const truth = condition ? literalTruth(condition, budget) : ts.isForStatement(statement) ? true : undefined;
      if (skippedAdmissionLoop(statement, budget)) {
        memo.set(statement, { mask: NORMAL_COMPLETION });
        continue;
      }
      if (!expanded) {
        pending.push({ node: statement, expanded: true }, { node: statement.statement, expanded: false });
        continue;
      }
      const body = memo.get(statement.statement)!;
      let mask = body.mask & ~(BREAK_COMPLETION | CONTINUE_COMPLETION | NORMAL_COMPLETION);
      if (body.mask & BREAK_COMPLETION || body.breaks?.has(statement) || truth !== true && (!ts.isDoStatement(statement)
        || body.mask & (NORMAL_COMPLETION | CONTINUE_COMPLETION) || body.continues?.has(statement))) mask |= NORMAL_COMPLETION;
      const breaks = new Set<ts.Statement>();
      const continues = new Set<ts.Statement>();
      mergeTargets(breaks, body.breaks, budget, statement);
      mergeTargets(continues, body.continues, budget, statement);
      memo.set(statement, outcomes(mask, breaks, continues));
      continue;
    }
    if (ts.isSwitchStatement(statement)) {
      const dispatch = switchDispatch(statement, budget);
      const clauses = statement.caseBlock.clauses;
      if (!expanded) {
        pending.push({ node: statement, expanded: true });
        let possible = false;
        for (const clause of clauses) {
          budget.take();
          if (!possible && !dispatch.direct.has(clause)) continue;
          possible = true;
          for (const child of clause.statements) {
            budget.take();
            // A direct abrupt statement never falls through to a following case.
            pending.push({ node: child, expanded: false });
            if (ts.isReturnStatement(child) || ts.isThrowStatement(child) || ts.isBreakStatement(child)
              || ts.isContinueStatement(child)) { possible = false; break; }
          }
        }
        continue;
      }
      let exits = dispatch.unmatched ? NORMAL_COMPLETION : 0;
      let flowing = false;
      const breaks = new Set<ts.Statement>();
      const continues = new Set<ts.Statement>();
      for (const clause of clauses) {
        budget.take();
        if (!flowing && !dispatch.direct.has(clause)) continue;
        flowing = true;
        for (const child of clause.statements) {
          budget.take();
          const outcome = memo.get(child)!;
          exits |= outcome.mask & ~NORMAL_COMPLETION;
          mergeTargets(breaks, outcome.breaks, budget);
          mergeTargets(continues, outcome.continues, budget);
          flowing = !!(outcome.mask & NORMAL_COMPLETION);
          if (!flowing) break;
        }
      }
      if (flowing || exits & BREAK_COMPLETION) exits = (exits & ~BREAK_COMPLETION) | NORMAL_COMPLETION;
      memo.set(statement, outcomes(exits, breaks, continues));
      continue;
    }
    if (ts.isIfStatement(statement) || ts.isBlock(statement) || ts.isLabeledStatement(statement)
      || ts.isTryStatement(statement)) {
      let children: readonly ts.Statement[];
      let skippedBranch = false;
      if (ts.isIfStatement(statement)) {
        const truth = literalTruth(statement.expression, budget);
        children = truth === true ? [statement.thenStatement]
          : truth === false ? statement.elseStatement ? [statement.elseStatement] : []
          : statement.elseStatement ? [statement.thenStatement, statement.elseStatement] : [statement.thenStatement];
        skippedBranch = !statement.elseStatement && truth !== true;
      } else if (ts.isTryStatement(statement)) {
        children = statement.catchClause ? [statement.tryBlock, statement.catchClause.block] : [statement.tryBlock];
      } else children = ts.isBlock(statement) ? flowStatements(statement, budget) : [statement.statement];
      if (!expanded) {
        pending.push({ node: statement, expanded: true });
        if (ts.isTryStatement(statement) && statement.finallyBlock) {
          budget.take();
          pending.push({ node: statement.finallyBlock, expanded: false });
        }
        for (const child of children) { budget.take(); pending.push({ node: child, expanded: false }); }
        continue;
      }
      let exits = ts.isBlock(statement) || skippedBranch ? NORMAL_COMPLETION : 0;
      const breaks = new Set<ts.Statement>();
      const continues = new Set<ts.Statement>();
      for (const child of children) {
        budget.take();
        if (ts.isBlock(statement)) {
          if (!(exits & NORMAL_COMPLETION)) break;
          exits &= ~NORMAL_COMPLETION;
        }
        const outcome = memo.get(child)!;
        // A local catch consumes thrown exits, while returns still escape.
        exits |= ts.isTryStatement(statement) && statement.catchClause && child === statement.tryBlock
          ? outcome.mask & ~THROW_COMPLETION : outcome.mask;
        mergeTargets(breaks, outcome.breaks, budget);
        mergeTargets(continues, outcome.continues, budget);
      }
      if (ts.isTryStatement(statement) && statement.finallyBlock) {
        const final = memo.get(statement.finallyBlock)!;
        if (!(final.mask & NORMAL_COMPLETION)) {
          exits = 0;
          breaks.clear();
          continues.clear();
        }
        exits |= final.mask & ~NORMAL_COMPLETION;
        mergeTargets(breaks, final.breaks, budget);
        mergeTargets(continues, final.continues, budget);
      }
      if (ts.isLabeledStatement(statement) && breaks.delete(labeledBody(statement, budget))) exits |= NORMAL_COMPLETION;
      memo.set(statement, outcomes(exits, breaks, continues));
    } else {
      const jump = ts.isBreakStatement(statement) || ts.isContinueStatement(statement);
      const target = jump && statement.label ? labelTarget(statement, budget) : undefined;
      const exit = ts.isReturnStatement(statement) ? EXIT_COMPLETION
        : ts.isThrowStatement(statement) ? THROW_COMPLETION
        : ts.isBreakStatement(statement) ? target ? LABELED_BREAK_COMPLETION : BREAK_COMPLETION
        : ts.isContinueStatement(statement) ? target ? LABELED_CONTINUE_COMPLETION : CONTINUE_COMPLETION
        : NORMAL_COMPLETION;
      memo.set(statement, { mask: exit,
        breaks: exit === LABELED_BREAK_COMPLETION && target ? new Set([target]) : undefined,
        continues: exit === LABELED_CONTINUE_COMPLETION && target ? new Set([target]) : undefined });
    }
  }
  return memo.get(node)!;
}

function allowsTarget(targets: ReadonlySet<ts.Statement> | undefined, labels: readonly ts.Statement[] | undefined,
  budget: AnalysisBudget): boolean {
  if (!targets) return false;
  if (!labels) return true;
  for (const target of labels) {
    budget.take();
    if (targets.has(target)) return true;
  }
  return false;
}

function allowsCompletion(outcome: StatementOutcomes, mask: number, budget: AnalysisBudget,
  labeled?: readonly ts.Statement[], continuingLabels?: readonly ts.Statement[]): boolean {
  const shared = outcome.mask & mask;
  return !!(shared & ~(LABELED_BREAK_COMPLETION | LABELED_CONTINUE_COMPLETION))
    || !!(shared & LABELED_BREAK_COMPLETION) && allowsTarget(outcome.breaks, labeled, budget)
    || !!(shared & LABELED_CONTINUE_COMPLETION) && allowsTarget(outcome.continues, continuingLabels, budget);
}

type AwaitSearch = {
  summaries: WeakMap<ts.Statement, Map<string, boolean>>;
  targets: WeakMap<ts.Statement, number>;
  targetCount: number;
};

const repeatedAwaitSearches = new WeakMap<AnalysisBudget, AwaitSearch>();

function repeatedAwaitSearch(budget: AnalysisBudget): AwaitSearch {
  let search = repeatedAwaitSearches.get(budget);
  if (!search) {
    search = { summaries: new WeakMap(), targets: new WeakMap(), targetCount: 0 };
    repeatedAwaitSearches.set(budget, search);
  }
  return search;
}

function awaitTargetKey(labels: readonly ts.Statement[] | undefined, search: AwaitSearch, budget: AnalysisBudget): string {
  if (!labels) return "*";
  const keys: number[] = [];
  for (const label of labels) {
    budget.take();
    let key = search.targets.get(label);
    if (key === undefined) { key = search.targetCount++; search.targets.set(label, key); }
    keys.push(key);
  }
  return keys.join(",");
}

function awaitEnds(node: ts.Node, budget: AnalysisBudget, continuing = false,
  completion = continuing ? NORMAL_COMPLETION : ANY_COMPLETION, iteration?: ts.IterationStatement,
  search?: AwaitSearch): number[] {
  type Memo = { key: string; results: Map<string, boolean> };
  type Task = { node: ts.Node; completion: number; labeled?: readonly ts.Statement[];
    continuingLabels?: readonly ts.Statement[] };
  const pending: Array<Task | { finished: Memo }> = [{ node, completion, continuingLabels: iteration && [iteration] }];
  const active: Memo[] = [];
  const ends: number[] = [];
  const optional = new WeakMap<ts.OptionalChain, ts.Expression | null>();
  while (pending.length) {
    if (search && ends.length) {
      for (const memo of active) { budget.take(); memo.results.set(memo.key, true); }
      return ends;
    }
    budget.take();
    const task = pending.pop()!;
    if ("finished" in task) {
      active.pop();
      task.finished.results.set(task.finished.key, false);
      continue;
    }
    const current = task.node;
    const enqueue = (child: ts.Node, completion?: number,
      labeled = completion === undefined ? undefined : task.labeled,
      continuingLabels = completion === undefined ? undefined : task.continuingLabels): void => {
      pending.push({ node: child, completion: completion ?? ANY_COMPLETION, labeled, continuingLabels });
    };
    const completes = (statement: ts.Statement, completion: number): boolean =>
      allowsCompletion(statementCompletions(statement, budget), completion, budget, task.labeled, task.continuingLabels);
    if (search && ts.isStatement(current)) {
      const key = `${task.completion}:${awaitTargetKey(task.labeled, search, budget)}:${awaitTargetKey(task.continuingLabels, search, budget)}`;
      let results = search.summaries.get(current);
      if (!results) { results = new Map(); search.summaries.set(current, results); }
      const cached = results.get(key);
      if (cached !== undefined) {
        if (cached) ends.push(current.end);
        continue;
      }
      const memo = { key, results };
      active.push(memo);
      pending.push({ finished: memo });
    }
    if (ts.isFunctionLike(current)) continue;
    const unrestricted = task.completion === ANY_COMPLETION && !task.labeled && !task.continuingLabels;
    // A catch may observe an exception raised before a statement's modeled
    // completion, even in a loop with no ordinary exit.
    if (!unrestricted && ts.isStatement(current) && !completes(current, task.completion)) continue;
    if (ts.isBlock(current)) {
      // Only normal completion of an earlier statement reaches the next one.
      const statements = flowStatements(current, budget);
      let last = 0;
      for (; last < statements.length; last++) {
        budget.take();
        if (!(statementCompletions(statements[last], budget).mask & NORMAL_COMPLETION)) { last++; break; }
      }
      let allowed = task.completion;
      for (let i = last - 1; i >= 0; i--) {
        budget.take();
        const statement = statements[i];
        enqueue(statement, allowed);
        allowed = (task.completion & ~NORMAL_COMPLETION)
          | (completes(statement, allowed) ? NORMAL_COMPLETION : 0);
      }
      continue;
    }
    if (ts.isLabeledStatement(current)) {
      if (!(task.completion & NORMAL_COMPLETION) || task.completion === ANY_COMPLETION && !task.labeled) {
        enqueue(current.statement, task.completion, task.labeled);
      } else {
        budget.take(task.labeled?.length ?? 0);
        enqueue(current.statement, task.completion | LABELED_BREAK_COMPLETION, [
          ...task.labeled ?? [], labeledBody(current, budget),
        ]);
      }
      continue;
    }
    if (ts.isIfStatement(current) || ts.isConditionalExpression(current)) {
      const condition = ts.isIfStatement(current) ? current.expression : current.condition;
      const yes = ts.isIfStatement(current) ? current.thenStatement : current.whenTrue;
      const no = ts.isIfStatement(current) ? current.elseStatement : current.whenFalse;
      const truth = literalTruth(condition, budget);
      enqueue(condition);
      if (truth !== false) enqueue(yes, task.completion);
      if (truth !== true && no) enqueue(no, task.completion);
      continue;
    }
    if (ts.isBinaryExpression(current)) {
      const operator = current.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken) {
        const truth = literalTruth(current.left, budget);
        enqueue(current.left);
        if (truth !== (operator === ts.SyntaxKind.BarBarToken)) enqueue(current.right);
        continue;
      }
      if (operator === ts.SyntaxKind.QuestionQuestionToken) {
        enqueue(current.left);
        if (literalNullish(current.left, budget) !== false) enqueue(current.right);
        continue;
      }
    }
    if (ts.isOptionalChain(current)) {
      const receiver = skippedOptionalReceiver(current, optional, budget);
      if (receiver) { enqueue(receiver); continue; }
    }
    if (ts.isWhileStatement(current) || ts.isForStatement(current) || ts.isDoStatement(current)
      || ts.isForOfStatement(current) || ts.isForInStatement(current)) {
      const condition = loopCondition(current);
      if (condition && !ts.isDoStatement(current)) enqueue(condition);
      if (ts.isForStatement(current) && current.initializer) enqueue(current.initializer);
      const skipped = skippedAdmissionLoop(current, budget);
      if (ts.isForOfStatement(current) || ts.isForInStatement(current)) {
        enqueue(current.expression);
        if (!skipped) for (const binding of loopBindingEvaluations(current, budget)) {
          budget.take();
          enqueue(binding);
        }
        if (ts.isForOfStatement(current) && current.awaitModifier) ends.push(current.expression.end);
        if (ts.isForOfStatement(current) && !skipped && awaitUsing(current.initializer)) ends.push(current.end);
      }
      if (!skipped) {
        const body = statementCompletions(current.statement, budget);
        let bodyCompletion = task.completion & (EXIT_COMPLETION | THROW_COMPLETION | LABELED_BREAK_COMPLETION | LABELED_CONTINUE_COMPLETION);
        if (task.completion & NORMAL_COMPLETION) {
          bodyCompletion |= NORMAL_COMPLETION | BREAK_COMPLETION | CONTINUE_COMPLETION;
          if (ts.isLabeledStatement(current.parent)) {
            budget.take((task.labeled?.length ?? 0) + (task.continuingLabels?.length ?? 0));
            enqueue(current.statement, bodyCompletion | LABELED_BREAK_COMPLETION | LABELED_CONTINUE_COMPLETION,
              task.completion & LABELED_BREAK_COMPLETION && !task.labeled ? undefined : [...task.labeled ?? [], current],
              task.completion & LABELED_CONTINUE_COMPLETION && !task.continuingLabels ? undefined
                : [...task.continuingLabels ?? [], current]);
          } else enqueue(current.statement, bodyCompletion);
        } else enqueue(current.statement, bodyCompletion);
        const reachesTail = body.mask & (NORMAL_COMPLETION | CONTINUE_COMPLETION) || body.continues?.has(current);
        if (ts.isForStatement(current) && current.incrementor && reachesTail) enqueue(current.incrementor);
        if (ts.isDoStatement(current) && reachesTail) enqueue(current.expression);
      }
      continue;
    }
    if (ts.isSwitchStatement(current)) {
      enqueue(current.expression);
      const exits = (task.completion & ~(NORMAL_COMPLETION | BREAK_COMPLETION))
        | (task.completion & NORMAL_COMPLETION ? BREAK_COMPLETION : 0);
      let fallsThrough = !!(task.completion & NORMAL_COMPLETION);
      const clauses = current.caseBlock.clauses;
      const dispatch = switchDispatch(current, budget);
      const direct = dispatch.direct;
      const reachable = new Set<ts.CaseOrDefaultClause>();
      let flowing = false;
      for (const clause of clauses) {
        budget.take();
        if (!flowing && !direct.has(clause)) continue;
        reachable.add(clause);
        flowing = clause.statements.every(child => {
          budget.take();
          return !!(statementCompletions(child, budget).mask & NORMAL_COMPLETION);
        });
      }
      // A dispatch entry evaluates a prefix of the case tests.
      let lastTest = dispatch.unmatched && task.completion & NORMAL_COMPLETION ? dispatch.tests.length : 0;
      for (let index = clauses.length - 1; index >= 0; index--) {
        budget.take();
        const clause = clauses[index];
        if (!reachable.has(clause)) continue;
        let last = 0;
        for (; last < clause.statements.length; last++) {
          budget.take();
          if (!(statementCompletions(clause.statements[last], budget).mask & NORMAL_COMPLETION)) {
            fallsThrough = false;
            last++;
            break;
          }
        }
        for (let index = last - 1; index >= 0; index--) {
          budget.take();
          const child = clause.statements[index];
          const allowed = exits | (fallsThrough ? NORMAL_COMPLETION : 0);
          enqueue(child, allowed);
          fallsThrough = completes(child, allowed);
        }
        if (fallsThrough) lastTest = Math.max(lastTest, direct.get(clause) ?? 0);
      }
      // An exception in a case test can still reach a surrounding catch
      // when this search does not filter the switch's completion.
      if (unrestricted) lastTest = dispatch.tests.length;
      for (let i = 0; i < lastTest; i++) { budget.take(); enqueue(dispatch.tests[i]); }
      continue;
    }
    if (ts.isTryStatement(current)) {
      const caught = current.catchClause?.block;
      let priorCompletion = task.completion;
      let overridesPrior = false;
      if (current.finallyBlock) {
        const final = statementCompletions(current.finallyBlock, budget);
        const abruptCompletion = task.completion & ~NORMAL_COMPLETION;
        const normalReachesTarget = completes(current.tryBlock, task.completion) || caught && completes(caught, task.completion);
        enqueue(current.finallyBlock, abruptCompletion | (normalReachesTarget ? NORMAL_COMPLETION : 0));
        overridesPrior = allowsCompletion(final, abruptCompletion, budget, task.labeled, task.continuingLabels);
        if (overridesPrior) priorCompletion = ANY_COMPLETION;
        else if (!(final.mask & NORMAL_COMPLETION)) priorCompletion = 0;
      }
      // A potentially throwing operation in the try can reach the catch.
      // If the catch cannot reach the enqueue, only the try's own allowed exits matter.
      const catchCanContinue = caught && completes(caught, priorCompletion);
      enqueue(current.tryBlock, catchCanContinue || overridesPrior ? undefined : priorCompletion);
      if (catchCanContinue && current.catchClause?.variableDeclaration) enqueue(current.catchClause.variableDeclaration);
      if (caught) enqueue(caught, overridesPrior ? undefined : priorCompletion);
      continue;
    }
    if (ts.isAwaitExpression(current)) ends.push(current.expression.end);
    if (awaitUsing(current)) {
      const owner = ts.isVariableStatement(current.parent) ? current.parent.parent : current.parent;
      const scope = ts.isCaseClause(owner) || ts.isDefaultClause(owner) ? owner.parent : owner;
      // Registration runs synchronously. Only an exit from the resource's
      // enclosing scope can suspend code after it.
      if (scope.pos >= node.pos && scope.end <= node.end) ends.push(scope.end);
    }
    // A nested try or loop can intercept a throw or override completion.
    // Preserve suspension evidence through control that we haven't classified.
    ts.forEachChild(current, child => { enqueue(child); });
  }
  return ends.sort((left, right) => { budget.take(); return left - right; });
}

/** Even a stale snapshot identifies the queue for rejecting generic proof. */
type GuardSite = ts.IfStatement | ts.ConditionalExpression | ts.BinaryExpression | ts.WhileStatement | ts.ForStatement;

function guardCondition(site: GuardSite): ts.Expression {
  if (ts.isBinaryExpression(site)) return site.left;
  if (ts.isConditionalExpression(site) || ts.isForStatement(site)) return site.condition!;
  return site.expression;
}

function admissionCounter(expression: ts.Expression, statement: GuardSite, budget: AnalysisBudget,
  current = false, after?: number): ts.Symbol | undefined {
  const read = expression;
  let first: ts.VariableStatement | undefined;
  const visited = new Set<ts.Symbol>();
  for (;;) {
    const direct = readCounter(expression, budget);
    if (direct) return !current || !first || (after === undefined || first.end > after)
      && snapshotCurrent(first, statement, read, budget) ? direct : undefined;
    const binding = immutableBinding(expression, budget);
    const declaration = binding?.valueDeclaration;
    if (!binding || visited.has(binding) || !declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer
      || !ts.isVariableStatement(declaration.parent.parent)) return undefined;
    budget.take();
    if (current && (!ts.isVariableDeclarationList(declaration.parent) || declaration.parent.declarations.length !== 1
      || declaration.end > expression.pos)) return undefined;
    visited.add(binding);
    first = declaration.parent.parent;
    expression = declaration.initializer;
  }
}

// Positions are file-local. A statement's next possible queue change is the
// same for every snapshot in the uninterrupted run of reads preceding it.
const snapshotBoundaries = new WeakMap<AnalysisBudget, WeakMap<ts.Statement, number>>();

function snapshotCurrent(first: ts.VariableStatement, guard: GuardSite, read: ts.Expression, budget: AnalysisBudget): boolean {
  // A snapshot made outside a loop was taken only once. Its condition may
  // run again after the producer has already changed the depth.
  if (ts.isIterationStatement(guard, false)) return false;
  let entry: ts.Node = guard;
  if (!ts.isIfStatement(guard)) {
    entry = read;
    while (!ts.isStatement(entry)) {
      budget.take();
      const parent: ts.Node = entry.parent;
      // Only certify a snapshot in a leading expression. An earlier call or
      // getter in the same statement may already have changed the queue.
      if (unwrapParent(parent) || ts.isPrefixUnaryExpression(parent)
        || ts.isBinaryExpression(parent) && (parent.left === entry || primitivePatch(parent.left))
        || ts.isConditionalExpression(parent) && parent.condition === entry
        || ts.isExpressionStatement(parent) || ts.isReturnStatement(parent) || ts.isIfStatement(parent)) entry = parent;
      else return false;
    }
  }
  const scope = entry.parent;
  if (first.parent !== scope || first.end > entry.pos || (!ts.isBlock(scope) && !ts.isCaseClause(scope)
    && !ts.isDefaultClause(scope))) return false;
  let boundaries = snapshotBoundaries.get(budget);
  if (!boundaries) { boundaries = new WeakMap(); snapshotBoundaries.set(budget, boundaries); }
  const known = boundaries.get(first);
  if (known !== undefined) return entry.pos <= known;
  const statements = scope.statements;
  let low = 0, high = statements.length;
  while (low < high) {
    budget.take();
    const mid = (low + high) >>> 1;
    if (statements[mid].pos < first.pos) low = mid + 1;
    else high = mid;
  }
  if (statements[low] !== first) return false;
  const pending: ts.Statement[] = [first];
  let until = scope.end;
  for (let index = low + 1; index < statements.length; index++) {
    budget.take();
    const statement = statements[index];
    const declaration = ts.isVariableStatement(statement) && !awaitUsing(statement.declarationList) && (statement.declarationList.flags & ts.NodeFlags.Const)
      && statement.declarationList.declarations.length === 1 ? statement.declarationList.declarations[0] : undefined;
    if (!(declaration && ts.isIdentifier(declaration.name) && declaration.initializer
      && ts.isIdentifier(unwrap(declaration.initializer, budget))) && !snapshotLog(statement, budget)) {
      until = statement.pos;
      break;
    }
    const cached = boundaries.get(statement);
    if (cached !== undefined) { until = cached; break; }
    pending.push(statement);
  }
  for (const statement of pending) { budget.take(); boundaries.set(statement, until); }
  return entry.pos <= until;
}

function snapshotLog(statement: ts.Statement, budget: AnalysisBudget): boolean {
  if (ts.isEmptyStatement(statement)) return true;
  if (!ts.isExpressionStatement(statement)) return false;
  const call = workCall(statement, budget);
  if (!call || !ts.isPropertyAccessExpression(call.expression)) return false;
  const { expression, name } = call.expression;
  if (!ts.isIdentifier(expression) || expression.text !== "console" || !hostIdentifier(expression)
    || !["debug", "info", "log", "warn", "error"].includes(name.text)) return false;
  for (const argument of call.arguments) {
    budget.take();
    const value = unwrap(argument, budget);
    if (!ts.isStringLiteralLike(value) && !ts.isNumericLiteral(value) && !immutableBinding(value, budget)) return false;
  }
  return true;
}

type BooleanHelper = "call" | "apply" | "bind";
interface BooleanInput {
  value?: ts.Expression;
  unknown?: boolean;
  /** A spread hole supplies undefined; it is still a bound argument. */
  present?: true;
}
interface BooleanHelperRead { site: ts.CallExpression; method: BooleanHelper; owner?: ts.Node; previous?: BooleanHelperRead }
interface BooleanOrigin {
  native: boolean;
  capture?: ts.Node;
  bound?: BooleanInput;
  helpers?: BooleanHelperRead;
  object?: ts.Node;
}

/** Only direct literal spreads supply arguments here. Aliased arrays contain
 * captured values and must not become live counter reads at later calls. */
function booleanInput(arguments_: readonly ts.Expression[], budget: AnalysisBudget, skip = 0): BooleanInput {
  const pending = [{ items: arguments_, index: 0 }];
  while (pending.length) {
    budget.take();
    const frame = pending[pending.length - 1];
    if (frame.index >= frame.items.length) { pending.pop(); continue; }
    const item = frame.items[frame.index++];
    if (ts.isSpreadElement(item)) {
      const value = unwrap(item.expression, budget);
      if (!ts.isArrayLiteralExpression(value)) return { value, unknown: true, present: true };
      pending.push({ items: value.elements, index: 0 });
      continue;
    }
    if (skip) { skip--; continue; }
    return ts.isOmittedExpression(item) ? { present: true } : { value: item, present: true };
  }
  return {};
}

function booleanHelper(expression: ts.Expression, admission: AdmissionIndex, budget: AnalysisBudget):
  { receiver: ts.Expression; method: BooleanHelper } | undefined {
  const value = unwrap(expression, budget);
  if (!ts.isPropertyAccessExpression(value) && !ts.isElementAccessExpression(value)) return undefined;
  const key = patchMemberKey(value, admission.timerAliases, budget);
  return key === "call" || key === "apply" || key === "bind" ? { receiver: value.expression, method: key } : undefined;
}

/** Preserve the function value captured by an immutable alias, rather than
 * treating every later call as a fresh read of the host property. */
function booleanOrigin(expression: ts.Expression, admission: AdmissionIndex, budget: AnalysisBudget): BooleanOrigin | undefined {
  type Step = { kind: "visit"; value: ts.Expression }
    | { kind: "alias"; symbol: ts.Symbol; capture: ts.Expression; shadowed: boolean }
    | { kind: "bind"; site: ts.CallExpression; input: BooleanInput };
  const pending: Step[] = [{ kind: "visit", value: expression }];
  const seen = new Set<ts.Symbol>();
  let origin: BooleanOrigin | undefined;
  while (pending.length) {
    budget.take();
    const step = pending.pop()!;
    if (step.kind === "alias") {
      if (!origin && step.shadowed) origin = { native: false };
      if (origin && !origin.capture) origin = { ...origin, capture: step.capture };
      admission.booleanOrigins.set(step.symbol, origin ?? null);
      continue;
    }
    if (step.kind === "bind") {
      if (origin) origin = {
        ...origin, capture: origin.capture ?? step.site,
        bound: origin.bound ?? (step.input.present ? step.input : undefined),
        helpers: { site: step.site, method: "bind", owner: origin.object, previous: origin.helpers },
        object: step.site,
      };
      continue;
    }
    const value = unwrap(step.value, budget);
    if (ts.isCallExpression(value)) {
      const helper = booleanHelper(value.expression, admission, budget);
      if (helper?.method === "bind") {
        pending.push({ kind: "bind", site: value, input: booleanInput(value.arguments, budget, 1) },
          { kind: "visit", value: helper.receiver });
      }
      continue;
    }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const key = ts.isPropertyAccessExpression(value) ? value.name.text
        : patchPropertyKey(value.argumentExpression, admission.timerAliases, budget);
      // The member's spelling is not proof that it preserves truthiness.
      // Keep custom wrappers on the untrusted path so their arguments cannot
      // evade queue-capacity checks through generic policy fallback.
      if (key === "Boolean") origin = {
        native: aliasesHostGlobal(value.expression, admission.globalAliases, budget, true),
      };
      continue;
    }
    if (!ts.isIdentifier(value)) continue;
    const shadowed = value.text === "Boolean" && !hostIdentifier(value);
    const symbol = symbolOf(value);
    const declaration = symbol?.valueDeclaration;
    if (symbol && admission.booleanOrigins.has(symbol)) {
      origin = admission.booleanOrigins.get(symbol) ?? undefined;
      continue;
    }
    if (symbol && seen.has(symbol)) continue;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
      && ts.isVariableDeclarationList(declaration.parent) && declaration.parent.flags & ts.NodeFlags.Const
      && declaration.end <= value.pos) {
      seen.add(symbol!);
      pending.push({ kind: "alias", symbol: symbol!, capture: declaration.initializer, shadowed },
        { kind: "visit", value: declaration.initializer });
      continue;
    }
    if (declaration && ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)
      && ts.isVariableDeclaration(declaration.parent.parent)) {
      const variable = declaration.parent.parent;
      const key = declaration.propertyName ?? declaration.name;
      const name = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text
        : ts.isComputedPropertyName(key) ? patchPropertyKey(key.expression, admission.timerAliases, budget) : undefined;
      if (!declaration.initializer && !declaration.dotDotDotToken && name === "Boolean" && variable.initializer
        && ts.isVariableDeclarationList(variable.parent) && variable.parent.flags & ts.NodeFlags.Const
        && variable.end <= value.pos && aliasesHostGlobal(variable.initializer, admission.globalAliases, budget, true)) {
        origin = { native: true, capture: variable.initializer };
        admission.booleanOrigins.set(symbol!, origin);
      }
      else if (shadowed) origin = { native: false };
      continue;
    }
    if (value.text === "Boolean") origin = { native: !shadowed };
  }
  return origin;
}

function nativeBooleanHelpers(origin: BooleanOrigin, admission: AdmissionIndex, budget: AnalysisBudget): boolean {
  const pending: BooleanHelperRead[] = [];
  let read = origin.helpers;
  let valid = true;
  while (read) {
    budget.take();
    const known = admission.booleanHelperReads.get(read);
    if (known !== undefined) { valid = known; break; }
    pending.push(read);
    const own = read.owner ? admission.booleanOwnHelperWrites.get(read.owner) : admission.booleanNativeHelperWrites;
    for (const writes of [admission.booleanHelperWrites, own]) {
      if (writes?.has(read.method)) {
        const write = writes.get(read.method);
        const position = booleanReadPosition(read.site, admission, budget);
        if (!write || read.site.getSourceFile() !== write.source || position < 0 || position >= write.position) {
          valid = false;
          break;
        }
      }
    }
    if (!valid) break;
    read = read.previous;
  }
  for (const item of pending) { budget.take(); admission.booleanHelperReads.set(item, valid); }
  return valid;
}

function booleanReadPosition(node: ts.Node, admission: AdmissionIndex, budget: AnalysisBudget): number {
  const path: ts.Node[] = [];
  let current = node;
  let known = admission.booleanReadPositions.get(current);
  while (known === undefined) {
    budget.take();
    path.push(current);
    const parent = current.parent;
    if (unwrapParent(parent)) { current = parent; known = admission.booleanReadPositions.get(current); continue; }
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === current
      && ts.isCallExpression(parent.parent) && parent.parent.expression === parent
      && booleanHelper(parent, admission, budget)) {
      current = parent.parent;
      known = admission.booleanReadPositions.get(current);
      continue;
    }
    known = orderedPatchPosition(current, admission.orderedBlocks, budget);
  }
  for (const part of path) { budget.take(); admission.booleanReadPositions.set(part, known); }
  return known;
}

function booleanCoercion(call: ts.CallExpression, admission: AdmissionIndex, budget: AnalysisBudget):
  { origin: BooleanOrigin; input: BooleanInput; captured: boolean } | undefined {
  let origin = booleanOrigin(call.expression, admission, budget);
  let input: BooleanInput;
  if (origin) input = booleanInput(call.arguments, budget);
  else {
    const helper = booleanHelper(call.expression, admission, budget);
    if (!helper || helper.method === "bind") return undefined;
    origin = booleanOrigin(helper.receiver, admission, budget);
    if (!origin) return undefined;
    origin = { ...origin, helpers: { site: call, method: helper.method, owner: origin.object, previous: origin.helpers } };
    input = booleanInput(call.arguments, budget, 1);
    if (helper.method === "apply" && input.value && !input.unknown) {
      const array = unwrap(input.value, budget);
      input = ts.isArrayLiteralExpression(array) ? booleanInput(array.elements, budget)
        : { value: array, unknown: true };
    }
  }
  return { origin, input: origin.bound ?? input, captured: !!origin.bound };
}

function nativeBooleanAt(origin: BooleanOrigin, admission: AdmissionIndex, budget: AnalysisBudget): boolean {
  if (!origin.native) return false;
  if (!admission.booleanWrites.has("Boolean")) return true;
  const write = admission.booleanWrites.get("Boolean");
  if (!write || !origin.capture || origin.capture.getSourceFile() !== write.source) return false;
  const capturedAt = booleanReadPosition(origin.capture, admission, budget);
  return capturedAt >= 0 && capturedAt < write.position;
}

/** Native Function helpers can be replaced independently of Boolean itself. */
function markBooleanHelperMutation(node: ts.Node, target: ts.Expression | undefined, admission: AdmissionIndex,
  unsafePatches: WeakSet<ts.ObjectLiteralExpression>, budget: AnalysisBudget): void {
  type Receiver = { owner?: ts.Node; prototype?: boolean };
  const helperObject = (expression: ts.Expression): Receiver | undefined => {
    const value = initializedAlias(expression, admission.timerAliases, budget);
    const origin = booleanOrigin(value, admission, budget);
    if (origin?.native) return { owner: origin.object };
    const prototype = namedAccess(value, "prototype");
    if (!prototype) return undefined;
    const owner = initializedAlias(prototype, admission.timerAliases, budget);
    if (ts.isIdentifier(owner) && owner.text === "Function" && hostIdentifier(owner)) return { prototype: true };
    const host = namedAccess(owner, "Function");
    return host && aliasesHostGlobal(host, admission.globalAliases, budget, true) ? { prototype: true } : undefined;
  };
  const mark = (receiver: Receiver, name?: string): void => {
    let writes = receiver.prototype ? admission.booleanHelperWrites : receiver.owner
      ? admission.booleanOwnHelperWrites.get(receiver.owner) : admission.booleanNativeHelperWrites;
    if (!writes) { writes = new Map(); admission.booleanOwnHelperWrites.set(receiver.owner!, writes); }
    for (const method of ["call", "apply", "bind"] as const) {
      if (name === undefined || name === "__proto__" || name === method) {
        recordTimerWrite(method, node, writes, admission.orderedBlocks, budget);
      }
    }
  };
  if (target) {
    for (const written of assignmentTargets(target, admission.booleanHelperTargets, budget)) {
      if (ts.isPropertyAccessExpression(written) || ts.isElementAccessExpression(written)) {
        const receiver = helperObject(written.expression);
        if (receiver) mark(receiver, patchMemberKey(written, admission.timerAliases, budget));
      }
    }
  }
  if (!ts.isCallExpression(node) || !node.arguments.length) return;
  const native = nativeTimerObjectMethod(node.expression, admission.timerAliases, budget);
  if (!native || !/^(assign|defineProperties|defineProperty|set|deleteProperty|setPrototypeOf)$/.test(native.key)) return;
  const receiver = helperObject(node.arguments[0]);
  if (!receiver) return;
  if (native.key === "setPrototypeOf") { mark(receiver); return; }
  if (native.key !== "assign" && native.key !== "defineProperties") {
    mark(receiver, node.arguments[1] && patchPropertyKey(node.arguments[1], admission.timerAliases, budget));
    return;
  }
  for (let index = 1; index < node.arguments.length; index++) {
    budget.take();
    const source = initializedAlias(node.arguments[index], admission.timerAliases, budget);
    if (!ts.isObjectLiteralExpression(source) || unsafePatches.has(source)) { mark(receiver); return; }
    let keys = admission.booleanHelperShapes.get(source);
    if (keys === undefined) {
      const known = new Set<string>();
      keys = known;
      for (const property of source.properties) {
        budget.take();
        const name = property.name;
        const key = name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text
          : ts.isComputedPropertyName(name) ? patchPropertyKey(name.expression, admission.timerAliases, budget) : undefined);
        if (key === undefined || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) { keys = null; break; }
        if (/^(call|apply|bind|__proto__)$/.test(key)) known.add(key);
      }
      admission.booleanHelperShapes.set(source, keys);
    }
    if (keys === null) { mark(receiver); return; }
    for (const key of keys) { budget.take(); mark(receiver, key); }
    if (native.key === "defineProperties") return;
  }
}

function admissionHelper(call: ts.CallExpression, admission: AdmissionIndex, budget: AnalysisBudget):
  { condition: ts.Expression; trusted: boolean } | undefined {
  if (call.questionDotToken) return undefined;
  const expression = unwrap(call.expression, budget);
  const receiver = call.arguments.length === 1 && call.arguments[0].kind === ts.SyntaxKind.NullKeyword
    && !ts.isOptionalChain(expression) ? namedAccess(expression, "call") : undefined;
  const callee = receiver ? unwrap(receiver, budget) : expression;
  if ((!receiver && call.arguments.length) || !ts.isIdentifier(callee)) return undefined;
  const declaration = symbolOf(callee)?.valueDeclaration;
  let fn: PlainFunction;
  if (declaration && ts.isFunctionDeclaration(declaration)) fn = declaration;
  else if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && immutableBinding(callee, budget)
    && declaration.end <= call.pos) {
    const value = unwrap(declaration.initializer, budget);
    if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) return undefined;
    fn = value;
  } else return undefined;
  if (("asteriskToken" in fn && fn.asteriskToken) || fn.parameters.length
    || ts.getModifiers(fn)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) || !fn.body) return undefined;
  const first = ts.isBlock(fn.body) && fn.body.statements.length === 1 ? fn.body.statements[0] : undefined;
  const condition = !ts.isBlock(fn.body) ? fn.body : first && ts.isReturnStatement(first) ? first.expression : undefined;
  if (!condition) return undefined;
  const stable = !ts.isFunctionDeclaration(fn) || !admission.writtenNames.has(callee.text)
    && !ts.getModifiers(fn)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
  return { condition, trusted: stable && (!receiver || admission.nativeQueueCall?.(call) === true) };
}

type GuardBound = readonly [ts.Symbol | undefined, ts.Symbol];
type CapacityEvidence = "bound" | "mention" | "uncertain";
type CapacityChecks = ReadonlyArray<readonly [ts.Symbol | undefined, ts.Symbol, CapacityEvidence]>;
interface GuardProof {
  bounds: ReadonlySet<GuardBound>;
  mentions: ReadonlySet<ts.Symbol>;
  uncertain?: ReadonlySet<ts.Symbol>;
  /** Selected values are Boolean, or also nullish in an exact-false fallback query. */
  exactType?: boolean;
  checks?: CapacityChecks;
}

/** A helper's result is reusable while the same captured limits are available.
 * Registrations in one lexical scope share a position interval, not an owner. */
interface GuardAvailability { scoped: boolean; after: number; before: number }
interface CachedGuardProof extends GuardAvailability { proof: GuardProof }

function mergeGuardAvailability(target: GuardAvailability, source: GuardAvailability): void {
  target.scoped ||= source.scoped;
  target.after = Math.max(target.after, source.after);
  target.before = Math.min(target.before, source.before);
}

function cachedGuardProof(entries: readonly CachedGuardProof[] | undefined, position: number,
  budget: AnalysisBudget): CachedGuardProof | undefined {
  if (!entries) return undefined;
  let low = 0, high = entries.length;
  while (low < high) {
    budget.take();
    const middle = (low + high) >>> 1;
    if (entries[middle].after <= position) low = middle + 1;
    else high = middle;
  }
  const entry = entries[low - 1];
  return entry && position < entry.before ? entry : undefined;
}

function cacheGuardProof(proofs: Map<number, CachedGuardProof[]>, key: number, entry: CachedGuardProof,
  budget: AnalysisBudget): void {
  const entries = proofs.get(key);
  if (!entries) { proofs.set(key, [entry]); return; }
  let low = 0, high = entries.length;
  while (low < high) {
    budget.take();
    const middle = (low + high) >>> 1;
    if (entries[middle].after < entry.after) low = middle + 1;
    else high = middle;
  }
  // The shifted entries count too when an earlier registration is analyzed late.
  budget.take(entries.length - low + 1);
  entries.splice(low, 0, entry);
}

/** A callback created by a top-level initializer cannot run before that initializer. */
function guardStartup(statement: GuardSite, cache: AdmissionIndex["guardStartups"], budget: AnalysisBudget): ts.Statement | undefined {
  const path: ts.Node[] = [];
  let current = statement.parent;
  if (ts.isSourceFile(current)) return undefined;
  let owner = cache.get(current);
  while (owner === undefined) {
    budget.take();
    path.push(current);
    if (ts.isSourceFile(current.parent)) {
      owner = ts.isExpressionStatement(current) || ts.isVariableStatement(current) ? current : null;
      break;
    }
    current = current.parent;
    owner = cache.get(current);
  }
  for (const node of path) { budget.take(); cache.set(node, owner); }
  return owner ?? undefined;
}

function capacityCountSymbols(statement: GuardSite, budget: AnalysisBudget, admission: AdmissionIndex, enterThen = false,
  after?: number):
  CapacityChecks {
  type Comparison = ts.SyntaxKind.LessThanToken | ts.SyntaxKind.LessThanEqualsToken
    | ts.SyntaxKind.GreaterThanToken | ts.SyntaxKind.GreaterThanEqualsToken;
  type HelperFrame = {
    condition: ts.Expression; proofs: Map<number, CachedGuardProof[]>; key: number; reusable: boolean;
    shared: Map<number, GuardProof>; availability: GuardAvailability;
  };
  type ProofMemo = WeakMap<ts.Expression, Map<number, GuardProof>>;
  type Visit = { kind: "visit"; expression: ts.Expression; negated: boolean; exact?: boolean;
    acceptNullish?: boolean; untrusted?: boolean; memo?: ProofMemo; after?: number };
  type Task = Visit
    | { kind: "leaveHelper"; frame: HelperFrame }
    | { kind: "memoize"; proofs: Map<number, GuardProof>; key: number }
    | { kind: "proof"; proof: GuardProof }
    | { kind: "ternaryArms"; condition: ts.Expression; call: Visit }
    | { kind: "booleanWrapper"; strictComparison?: boolean; untrusted?: boolean }
    | { kind: "combine"; conjunction: boolean; exact?: boolean; acceptNullish?: boolean; fixedTruth?: boolean;
        literalArmExact?: boolean; alternatives?: boolean; selector?: boolean };
  const inverse: Partial<Record<ts.SyntaxKind, Comparison>> = {
    [ts.SyntaxKind.LessThanToken]: ts.SyntaxKind.GreaterThanEqualsToken,
    [ts.SyntaxKind.LessThanEqualsToken]: ts.SyntaxKind.GreaterThanToken,
    [ts.SyntaxKind.GreaterThanToken]: ts.SyntaxKind.LessThanEqualsToken,
    [ts.SyntaxKind.GreaterThanEqualsToken]: ts.SyntaxKind.LessThanToken,
  };
  const pending: Task[] = [{ kind: "visit", expression: guardCondition(statement), negated: enterThen, after }];
  const results: GuardProof[] = [];
  const [empty, booleanEmpty] = admission.guardEmpty;
  const unknownBoolean = (): GuardProof => admission.guardUnknownBoolean ??= {
    bounds: empty.bounds, mentions: admission.relevantCounters,
    uncertain: admission.relevantCounters,
  };
  const ownedSets = new WeakSet<ReadonlySet<unknown>>();
  const reusableProofs = new WeakSet<GuardProof>();
  const own = <T>(set: Set<T>): Set<T> => { ownedSets.add(set); return set; };
  const freeze = (proof: GuardProof): void => {
    ownedSets.delete(proof.bounds);
    ownedSets.delete(proof.mentions);
    if (proof.uncertain) ownedSets.delete(proof.uncertain);
  };
  const proofMode = (task: Visit, untrusted = task.untrusted): number =>
    (task.negated ? 1 : 0) | (untrusted ? 2 : 0) | (task.exact ? 4 : 0) | (task.acceptNullish ? 8 : 0);
  const activeHelpers = new Set<ts.Expression>();
  const helperFrames: HelperFrame[] = [];
  let startup: ts.Statement | undefined;
  let group: WeakMap<ts.Expression, Map<number, CachedGuardProof[]>> | undefined;
  const intern = (count: ts.Symbol | undefined, counter: ts.Symbol): GuardBound => {
    let keys = admission.guardBounds.get(counter);
    if (!keys) {
      keys = new Map();
      admission.guardBounds.set(counter, keys);
    }
    let bound = keys.get(count);
    if (!bound) {
      bound = [count, counter];
      keys.set(count, bound);
    }
    return bound;
  };
  const mentionProof = (mentions: Set<ts.Symbol>, exactType = false): GuardProof => {
    if (!mentions.size) return exactType ? booleanEmpty : empty;
    if (mentions.size === 1) {
      const [counter] = mentions;
      const proofs = admission.guardMentions[exactType ? 1 : 0];
      const previous = proofs.get(counter);
      if (previous) return previous;
      const proof = { bounds: empty.bounds, mentions, exactType };
      proofs.set(counter, proof);
      return proof;
    }
    // Key by resolved symbol identity in scan order. The same spelling in
    // another scope may resolve to different counters or snapshots.
    const ids: number[] = [];
    for (const counter of mentions) {
      budget.take();
      let id = admission.guardCounterIds.get(counter);
      if (id === undefined) { id = admission.guardCounterIds.size; admission.guardCounterIds.set(counter, id); }
      ids.push(id);
    }
    const key = `${exactType}:${ids.join(",")}`;
    const previous = admission.guardMultipleMentions.get(key);
    if (previous) return previous;
    const proof = { bounds: empty.bounds, mentions, exactType };
    admission.guardMultipleMentions.set(key, proof);
    return proof;
  };
  const union = <T>(left: ReadonlySet<T>, right: ReadonlySet<T>): ReadonlySet<T> => {
    if (left === right || !right.size) return left;
    if (!left.size) return right;
    const [smaller, larger] = left.size < right.size ? [left, right] : [right, left];
    if (!ownedSets.has(larger)) {
      let subset = true;
      for (const value of smaller) {
        budget.take();
        if (!larger.has(value)) { subset = false; break; }
      }
      if (subset) return larger;
    }
    const result = ownedSets.has(larger) ? larger as Set<T> : own(new Set<T>());
    if (result !== larger) {
      budget.take(larger.size);
      for (const value of larger) result.add(value);
    }
    budget.take(smaller.size);
    for (const value of smaller) result.add(value);
    return result;
  };
  while (pending.length) {
    budget.take();
    const task = pending.pop()!;
    if (task.kind === "proof") { results.push(task.proof); continue; }
    if (task.kind === "memoize") {
      const proof = results[results.length - 1];
      freeze(proof);
      task.proofs.set(task.key, proof);
      reusableProofs.add(proof);
      continue;
    }
    if (task.kind === "ternaryArms") {
      const whenFalse = results.pop()!, whenTrue = results.pop()!;
      const differing = whenTrue.bounds !== whenFalse.bounds;
      const useTrue = differing && whenTrue.bounds.size > 0;
      const useFalse = differing && whenFalse.bounds.size > 0;
      const { call, condition } = task;
      // Arms need only the requested result once. The selector is queried for
      // both truthiness outcomes only when each arm can add a separate bound.
      const memo = call.memo ?? (useTrue && useFalse ? new WeakMap() : undefined);
      const selector = { ...call, expression: condition, negated: false, exact: false, acceptNullish: false, memo };
      const steps: Task[] = [{ kind: "proof", proof: whenTrue }, { kind: "proof", proof: whenFalse },
        { kind: "combine", conjunction: true, alternatives: true }];
      if (useTrue) {
        freeze(whenTrue);
        steps.push(selector, { kind: "proof", proof: whenTrue },
          { kind: "combine", conjunction: true }, { kind: "combine", conjunction: false });
      }
      if (useFalse) {
        freeze(whenFalse);
        steps.push({ ...selector, negated: true }, { kind: "proof", proof: whenFalse },
          { kind: "combine", conjunction: true }, { kind: "combine", conjunction: false });
      }
      if (!useTrue && !useFalse) steps.push(selector, { kind: "combine", conjunction: false, selector: true });
      for (let index = steps.length - 1; index >= 0; index--) pending.push(steps[index]);
      continue;
    }
    if (task.kind === "leaveHelper") {
      const { condition, proofs, key, reusable } = task.frame;
      activeHelpers.delete(condition);
      helperFrames.pop();
      if (helperFrames.length) mergeGuardAvailability(helperFrames[helperFrames.length - 1].availability, task.frame.availability);
      if (reusable) {
        let result = results[results.length - 1];
        if ((key & 2) && result.exactType) {
          result = { ...result, exactType: undefined };
          results[results.length - 1] = result;
        }
        freeze(result);
        cacheGuardProof(proofs, key, { ...task.frame.availability, proof: result }, budget);
        if (!task.frame.availability.scoped) task.frame.shared.set(key, result);
        reusableProofs.add(result);
      } else if (helperFrames.length) helperFrames[helperFrames.length - 1].reusable = false;
      continue;
    }
    if (task.kind === "booleanWrapper") {
      const proof = results.pop()!;
      if (task.untrusted && !proof.mentions.size) { results.push(unknownBoolean()); continue; }
      // The ordinary scalar guard heuristic cannot rescue a known counter
      // whose strict result or replaced coercion did not establish a bound.
      const uncertain = task.untrusted || task.strictComparison;
      if (!uncertain && proof.exactType) { results.push(proof); continue; }
      const views = task.untrusted ? admission.guardUntrustedViews
        : uncertain ? admission.guardUncertainViews : admission.guardBooleanViews;
      let wrapped = views.get(proof);
      if (!wrapped) {
        wrapped = {
          bounds: task.untrusted ? empty.bounds : proof.bounds, mentions: proof.mentions,
          uncertain: uncertain ? proof.mentions : proof.uncertain, exactType: !task.untrusted,
        };
        if (uncertain) ownedSets.delete(proof.mentions);
        if (!ownedSets.has(proof.bounds) && !ownedSets.has(proof.mentions)
          && (!proof.uncertain || !ownedSets.has(proof.uncertain))) views.set(proof, wrapped);
      }
      results.push(wrapped);
      continue;
    }
    if (task.kind === "combine") {
      const right = results.pop()!, left = results.pop()!;
      // Immutable operands have the same combined facts even when the
      // logical expressions appear in different guard statements.
      const share = !helperFrames.length
        && !ownedSets.has(left.bounds) && !ownedSets.has(left.mentions)
        && !ownedSets.has(right.bounds) && !ownedSets.has(right.mentions)
        && (!left.uncertain || !ownedSets.has(left.uncertain)) && (!right.uncertain || !ownedSets.has(right.uncertain));
      const mode = (task.conjunction ? 1 : 0) | (task.exact ? 2 : 0)
        | (task.literalArmExact === undefined ? 0 : task.literalArmExact ? 4 : 8)
        | (task.alternatives ? 16 : 0) | (task.selector ? 32 : 0)
        | (task.acceptNullish ? 64 : 0) | (task.fixedTruth ? 128 : 0);
      let combinations = admission.guardCombinations.get(mode);
      const cached = share ? combinations?.get(left)?.get(right) : undefined;
      if (cached) {
        reusableProofs.add(cached);
        results.push(cached);
        continue;
      }
      let bounds: ReadonlySet<GuardBound>;
      if (task.fixedTruth) bounds = empty.bounds;
      else if (task.selector) bounds = left.bounds;
      else if (task.conjunction && left.bounds !== right.bounds) {
        const [smaller, larger] = left.bounds.size < right.bounds.size ? [left.bounds, right.bounds] : [right.bounds, left.bounds];
        const common = own(new Set<GuardBound>());
        for (const bound of smaller) {
          budget.take();
          if (larger.has(bound)) common.add(bound);
        }
        bounds = common.size === smaller.size ? smaller : common;
      } else if (task.exact && !task.conjunction && task.literalArmExact === undefined && !left.exactType) {
        // The right value can be skipped by a matching truthiness on the
        // left. It proves an exact result only if that left value also matches.
        bounds = left.bounds;
      } else {
        bounds = union(left.bounds, right.bounds);
      }
      const mentions = union(left.mentions, right.mentions);
      const uncertain = left.uncertain && right.uncertain ? union(left.uncertain, right.uncertain)
        : left.uncertain ?? right.uncertain;
      // An unrelated sibling of a disjunction adds no capacity facts. Keep
      // the cached helper proof and its check-list identity in that case.
      const exactType = task.selector ? left.exactType === true
        : (task.literalArmExact ?? (!task.alternatives && task.conjunction || left.exactType === true)) && right.exactType === true;
      const unchanged = bounds === left.bounds && mentions === left.mentions && uncertain === left.uncertain ? left
        : bounds === right.bounds && mentions === right.mentions && uncertain === right.uncertain ? right : undefined;
      let proof = unchanged;
      if (unchanged && !!unchanged.exactType !== exactType) {
        if (reusableProofs.has(unchanged)) {
          const views = admission.guardBooleanViews;
          proof = views.get(unchanged);
          if (!proof) {
            proof = { bounds, mentions, uncertain, exactType };
            views.set(unchanged, proof);
          }
          reusableProofs.add(proof);
        } else proof = undefined;
      }
      proof ??= { bounds, mentions, uncertain, exactType };
      if (share) {
        ownedSets.delete(bounds);
        ownedSets.delete(mentions);
        if (uncertain) ownedSets.delete(uncertain);
        if (!combinations) { combinations = new WeakMap(); admission.guardCombinations.set(mode, combinations); }
        let byRight = combinations.get(left);
        if (!byRight) { byRight = new WeakMap(); combinations.set(left, byRight); }
        byRight.set(right, proof);
        reusableProofs.add(proof);
      }
      results.push(proof);
      continue;
    }
    // Only observations made after the last continuing suspension establish
    // current capacity. A fresh call may inspect an earlier helper declaration.
    if (task.after !== undefined && task.expression.pos >= task.after) task.after = undefined;
    if (task.after !== undefined && task.expression.end <= task.after) { results.push(empty); continue; }
    if (task.memo) {
      const key = proofMode(task);
      let proofs = task.memo.get(task.expression);
      const previous = proofs?.get(key);
      if (previous) { results.push(previous); continue; }
      if (!proofs) { proofs = new Map(); task.memo.set(task.expression, proofs); }
      pending.push({ kind: "memoize", proofs, key });
    }
    let test = admission.guardExpressions.get(task.expression);
    if (!test) {
      test = unwrap(task.expression, budget);
      admission.guardExpressions.set(task.expression, test);
    }
    const negated = task.negated;
    if (ts.isPrefixUnaryExpression(test) && test.operator === ts.SyntaxKind.ExclamationToken) {
      pending.push({ kind: "booleanWrapper" },
        { ...task, expression: test.operand, negated: !negated, exact: false, acceptNullish: false });
      continue;
    }
    if (ts.isConditionalExpression(test)) {
      const selector = literalTruth(test.condition, budget);
      if (selector !== undefined) {
        pending.push({ ...task, expression: selector ? test.whenTrue : test.whenFalse });
        continue;
      }
      const whenTrue = unwrap(test.whenTrue, budget).kind;
      const whenFalse = unwrap(test.whenFalse, budget).kind;
      if ((whenTrue === ts.SyntaxKind.TrueKeyword && whenFalse === ts.SyntaxKind.FalseKeyword)
        || (whenTrue === ts.SyntaxKind.FalseKeyword && whenFalse === ts.SyntaxKind.TrueKeyword)) {
        pending.push({ kind: "booleanWrapper" },
          { ...task, expression: test.condition, negated: negated !== (whenTrue === ts.SyntaxKind.FalseKeyword),
            exact: false, acceptNullish: false });
        continue;
      }
      // For Boolean results, null and undefined share the same truthiness
      // and both become false under the modeled nullish fallback.
      const literalValue = (arm: ts.Expression) => conditionBoolean(arm, budget)
        ?? (literalNullish(arm, budget) === true ? null : switchLiteral(arm, budget));
      const yes = literalValue(test.whenTrue), no = literalValue(test.whenFalse);
      const matchesLiteral = (literal: Exclude<typeof yes, undefined>) =>
        !!literal !== negated && (!task.exact || typeof literal === "boolean")
          || !!task.acceptNullish && literal === null;
      const literalExactType = (literal: Exclude<typeof yes, undefined>) =>
        typeof literal === "boolean" || !!literal === negated || !!task.acceptNullish && literal === null;
      if (yes !== undefined && no !== undefined) {
        const yesMatches = matchesLiteral(yes), noMatches = matchesLiteral(no);
        const exactType = literalExactType(yes) && literalExactType(no);
        if (yesMatches && noMatches) results.push(exactType ? booleanEmpty : empty);
        else {
          // A literal matching arm needs no additional queue-specific proof.
          // If neither matches, keep selector mentions but donate no bounds.
          pending.push({ kind: "combine", conjunction: false, exact: task.exact, acceptNullish: task.acceptNullish,
            fixedTruth: !yesMatches && !noMatches, literalArmExact: exactType },
            { kind: "proof", proof: booleanEmpty },
            { ...task, expression: test.condition, negated: !yesMatches, exact: false, acceptNullish: false });
        }
        continue;
      }
      if (yes !== undefined || no !== undefined) {
        const fromYes = yes !== undefined;
        const literal = fromYes ? yes : no;
        const matches = matchesLiteral(literal!);
        // The condition chooses the constant result, or must choose away
        // from it when that result would defeat the admission guard.
        pending.push({ kind: "combine", conjunction: !matches, exact: task.exact, acceptNullish: task.acceptNullish,
          literalArmExact: literalExactType(literal!) },
          { ...task, expression: fromYes ? test.whenFalse : test.whenTrue },
          { ...task, expression: test.condition, negated: fromYes !== matches, exact: false, acceptNullish: false });
        continue;
      }
      pending.push({ kind: "ternaryArms", condition: test.condition, call: task },
        { ...task, expression: test.whenFalse }, { ...task, expression: test.whenTrue });
      continue;
    }
    if (ts.isCallExpression(test)) {
      const coercion = booleanCoercion(test, admission, budget);
      if (coercion) {
        const native = nativeBooleanAt(coercion.origin, admission, budget)
          && nativeBooleanHelpers(coercion.origin, admission, budget)
          && !coercion.input.unknown;
        const constant = native && coercion.input.value ? literalTruth(coercion.input.value, budget)
          : native && !coercion.input.value ? false : undefined;
        if (constant !== undefined) {
          results.push(constant !== negated ? booleanEmpty : unknownBoolean());
          continue;
        }
        if (!coercion.input.value || coercion.input.unknown || coercion.captured) {
          results.push(unknownBoolean());
          continue;
        }
        pending.push({ kind: "booleanWrapper", untrusted: !native },
          { ...task, expression: coercion.input.value, untrusted: task.untrusted || !native, exact: false, acceptNullish: false });
        continue;
      }
      const helper = admissionHelper(test, admission, budget);
      if (helper && activeHelpers.has(helper.condition)) {
        helperFrames[helperFrames.length - 1].reusable = false;
      } else if (helper) {
        const untrusted = task.untrusted || !helper.trusted;
        const key = proofMode(task, untrusted);
        let shared = admission.guardSharedProofs.get(helper.condition);
        const independent = shared?.get(key);
        if (independent) {
          reusableProofs.add(independent);
          results.push(independent);
          continue;
        }
        if (!shared) { shared = new Map(); admission.guardSharedProofs.set(helper.condition, shared); }
        if (!group) {
          startup = guardStartup(statement, admission.guardStartups, budget);
          const owner = startup?.parent ?? admission.guardUnknownStartup;
          group = admission.guardProofs.get(owner) ?? new WeakMap();
          admission.guardProofs.set(owner, group);
        }
        const proofs = group.get(helper.condition) ?? new Map();
        group.set(helper.condition, proofs);
        const cached = cachedGuardProof(proofs.get(key), startup?.pos ?? -Infinity, budget);
        if (cached) {
          if (helperFrames.length) mergeGuardAvailability(helperFrames[helperFrames.length - 1].availability, cached);
          reusableProofs.add(cached.proof);
          results.push(cached.proof);
          continue;
        }
        const frame = { condition: helper.condition, proofs, shared, key, reusable: true,
          availability: { scoped: false, after: -Infinity, before: Infinity } };
        helperFrames.push(frame);
        activeHelpers.add(helper.condition);
        pending.push({ kind: "leaveHelper", frame }, { ...task, expression: helper.condition, untrusted, memo: undefined });
        continue;
      }
    }
    if (ts.isBinaryExpression(test)) {
      const raw = test.operatorToken.kind;
      if (raw === ts.SyntaxKind.QuestionQuestionToken
        && (unwrap(test.right, budget).kind === ts.SyntaxKind.FalseKeyword || guardNullish(test.left, admission, budget) === false)) {
        pending.push({ ...task, expression: test.left, acceptNullish: task.acceptNullish || !!task.exact && negated });
        continue;
      }
      if (raw === ts.SyntaxKind.EqualsEqualsEqualsToken || raw === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
        const right = conditionBoolean(test.right, budget), left = conditionBoolean(test.left, budget);
        const literal = right ?? left;
        if (literal !== undefined) {
          const equality = negated === (raw === ts.SyntaxKind.ExclamationEqualsEqualsToken);
          const truthy = equality === literal;
          pending.push({ kind: "booleanWrapper", strictComparison: true },
            { ...task, expression: right !== undefined ? test.left : test.right, negated: !truthy, exact: equality, acceptNullish: false });
          continue;
        }
      }
      if (raw === ts.SyntaxKind.BarBarToken || raw === ts.SyntaxKind.AmpersandAmpersandToken) {
        const or = raw === ts.SyntaxKind.BarBarToken;
        const leftBoolean = conditionBoolean(test.left, budget), rightBoolean = conditionBoolean(test.right, budget);
        const left = leftBoolean === undefined ? unwrap(test.left, budget).kind
          : leftBoolean ? ts.SyntaxKind.TrueKeyword : ts.SyntaxKind.FalseKeyword;
        const right = rightBoolean === undefined ? unwrap(test.right, budget).kind
          : rightBoolean ? ts.SyntaxKind.TrueKeyword : ts.SyntaxKind.FalseKeyword;
        const decisive = or ? ts.SyntaxKind.TrueKeyword : ts.SyntaxKind.FalseKeyword;
        const neutral = or ? ts.SyntaxKind.FalseKeyword : ts.SyntaxKind.TrueKeyword;
        const conjunction = !or !== negated;
        if (left === decisive) results.push(booleanEmpty);
        else if (left === neutral || literalTruth(test.left, budget) === !or) pending.push({ ...task, expression: test.right });
        else if (right === neutral) {
          // On the non-short-circuit path, the right literal becomes the
          // result. The left only needs to supply the controlling truthiness.
          if (conjunction) pending.push({ kind: "booleanWrapper" });
          pending.push({ ...task, expression: test.left, exact: !conjunction && task.exact,
            acceptNullish: !conjunction && task.acceptNullish });
        }
        else {
          const fixedTruth = right === decisive && !(task.exact && !conjunction);
          pending.push({ kind: "combine", conjunction, exact: task.exact, acceptNullish: task.acceptNullish, fixedTruth });
          pending.push({ ...task, expression: test.right }, { ...task, expression: test.left, exact: !conjunction && task.exact,
            acceptNullish: !conjunction && task.acceptNullish });
        }
        continue;
      }
      const operator = negated ? inverse[raw] : raw;
      const reversed = operator === ts.SyntaxKind.LessThanToken || operator === ts.SyntaxKind.LessThanEqualsToken;
      if (reversed || operator === ts.SyntaxKind.GreaterThanToken || operator === ts.SyntaxKind.GreaterThanEqualsToken) {
        const quantity = reversed ? test.right : test.left;
        const limit = reversed ? test.left : test.right;
        const available = helperFrames.length ? startup : undefined;
        const dependency = helperFrames[helperFrames.length - 1]?.availability;
        const remaining = remainingCapacity(limit, budget, available, dependency);
        const count = remaining ? immutableBinding(quantity, budget) : undefined;
        let counter = remaining && count ? remaining : undefined;
        if (!counter && finiteCap(limit, budget, available, dependency)) {
          counter = readCounter(quantity, budget);
          if (!counter) {
            // Snapshot freshness depends on the outer guard's exact statement.
            if (helperFrames.length && immutableBinding(quantity, budget)) helperFrames[helperFrames.length - 1].reusable = false;
            counter = admissionCounter(quantity, statement, budget, true, after);
          }
        }
        if (counter) {
          if (task.untrusted) results.push(mentionProof(new Set([counter])));
          else {
            const bound = intern(count, counter);
            let proof = admission.guardComparisons.get(bound);
            if (!proof) {
              proof = { bounds: new Set([bound]), mentions: new Set([counter]), exactType: true };
              admission.guardComparisons.set(bound, proof);
            }
            results.push(proof);
          }
          continue;
        }
      }
    }
    // Unsupported comparisons still name a queue. They must not fall back to
    // generic admission (for example equality can be skipped by a batch).
    const nodes: ts.Node[] = [test];
    const mentions = new Set<ts.Symbol>();
    while (nodes.length) {
      budget.take();
      const node = nodes.pop()!;
      if (ts.isFunctionLike(node)) continue;
      if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const counter = admissionCounter(node, statement, budget);
        if (counter) mentions.add(counter);
      }
      ts.forEachChild(node, child => { nodes.push(child); });
    }
    const exactType = test.kind === ts.SyntaxKind.TrueKeyword || test.kind === ts.SyntaxKind.FalseKeyword
      || ts.isBinaryExpression(test) && (inverse[test.operatorToken.kind] !== undefined
        || test.operatorToken.kind >= ts.SyntaxKind.EqualsEqualsToken
          && test.operatorToken.kind <= ts.SyntaxKind.ExclamationEqualsEqualsToken)
      || literalTruth(test, budget) === negated || !!task.acceptNullish && literalNullish(test, budget) === true;
    results.push(mentionProof(mentions, exactType));
  }
  const proof = results.pop() ?? empty;
  if (proof.checks) return proof.checks;
  // Queue identities are fixed for this audit. Project the shared proof once,
  // rather than copying unrelated counters into every route's mutable facts.
  const counts: Array<[ts.Symbol | undefined, ts.Symbol, CapacityEvidence]> = [];
  const established = new Set<ts.Symbol>();
  for (const [count, counter] of proof.bounds) {
    budget.take();
    if (!admission.relevantCounters.has(counter)) continue;
    counts.push([count, counter, "bound"]);
    established.add(counter);
  }
  for (const counter of proof.mentions) {
    budget.take();
    if (!admission.relevantCounters.has(counter)) continue;
    if (!established.has(counter) && !proof.uncertain?.has(counter)) counts.push([undefined, counter, "mention"]);
  }
  for (const counter of proof.uncertain ?? []) {
    budget.take();
    if (!admission.relevantCounters.has(counter)) continue;
    counts.push([undefined, counter, "uncertain"]);
  }
  return proof.checks = counts;
}

function admissionExitKind(statement: ts.Statement): "return" | "throw" | undefined {
  if (!ts.isIfStatement(statement) || statement.elseStatement) return undefined;
  const branch = statement.thenStatement;
  const kind = (node: ts.Statement) => ts.isReturnStatement(node) ? "return" : ts.isThrowStatement(node) ? "throw" : undefined;
  if (!ts.isBlock(branch)) return kind(branch);
  for (const prefix of branch.statements) {
    const exit = kind(prefix);
    if (exit) return exit;
    if (!ts.isExpressionStatement(prefix) && !ts.isVariableStatement(prefix) && !ts.isEmptyStatement(prefix)) return undefined;
  }
  return undefined;
}

function earlyAdmissionExit(statement: ts.Statement, budget: AnalysisBudget): statement is ts.IfStatement {
  budget.take(ts.isIfStatement(statement) && ts.isBlock(statement.thenStatement) ? statement.thenStatement.statements.length + 1 : 1);
  return admissionExitKind(statement) !== undefined;
}

interface PrefixGuardGroup { guards: readonly ts.IfStatement[]; children: readonly PrefixGuardGroup[] }
const prefixGuardMemos = new WeakMap<AnalysisBudget, readonly [WeakMap<ts.Statement, PrefixGuardGroup>, WeakMap<ts.Statement, PrefixGuardGroup>]>();
const inertPrefixMemos = new WeakMap<AnalysisBudget, WeakMap<ts.Statement, boolean>>();
const inertGuardMemos = new WeakMap<AnalysisBudget, WeakMap<ts.Expression, boolean>>();
/** A catch that resumes admission needs proof that evaluating the guard (or
 * its return value) cannot call unrelated code before the exit is reached. */
function inertGuardExpression(expression: ts.Expression, admission: AdmissionIndex, budget: AnalysisBudget): boolean {
  let memo = inertGuardMemos.get(budget);
  if (!memo) { memo = new WeakMap(); inertGuardMemos.set(budget, memo); }
  type Frame = { value: ts.Expression; children?: ts.Expression[] };
  const pending: Frame[] = [{ value: expression }], active = new Set<ts.Expression>();
  while (pending.length) {
    budget.take(); const frame = pending[pending.length - 1], node = frame.value;
    if (memo.has(node)) { active.delete(node); pending.pop(); continue; }
    if (frame.children) {
      let safe = true;
      for (const child of frame.children) { budget.take(); if (memo.get(child) !== true) { safe = false; break; } }
      memo.set(node, safe); active.delete(node); pending.pop(); continue;
    }
    active.add(node);
    const value = unwrap(node, budget);
    let children: ts.Expression[] | undefined;
    let safe = ts.isNumericLiteral(value) || ts.isBigIntLiteral(value) || ts.isStringLiteralLike(value)
      || value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword || value.kind === ts.SyntaxKind.NullKeyword
      || ts.isArrowFunction(value) || ts.isFunctionExpression(value);
    if (value !== node) children = [value];
    else if (ts.isIdentifier(value)) {
      const counter = mutableCounter(value, budget);
      safe = !!counter && admission.relevantCounters.has(counter);
      if (!safe) {
        const declaration = immutableBinding(value, budget)?.valueDeclaration;
        if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) children = [declaration.initializer];
      }
    } else if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) children = [value.operand];
    else if (ts.isBinaryExpression(value) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
      ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(value.operatorToken.kind)) {
      const op = value.operatorToken.kind, truth = literalTruth(value.left, budget), nullish = literalNullish(value.left, budget);
      children = (op === ts.SyntaxKind.AmpersandAmpersandToken && truth === false
        || op === ts.SyntaxKind.BarBarToken && truth === true || op === ts.SyntaxKind.QuestionQuestionToken && nullish === false)
        ? [value.left] : [value.left, value.right];
    } else if (ts.isConditionalExpression(value)) {
      const truth = literalTruth(value.condition, budget);
      children = truth === undefined ? [value.condition, value.whenTrue, value.whenFalse]
        : [value.condition, truth ? value.whenTrue : value.whenFalse];
    } else if (namedAccess(value, "length")) {
      const declaration = immutableBinding(namedAccess(value, "length")!, budget)?.valueDeclaration;
      safe = !!declaration && ts.isVariableDeclaration(declaration) && !!declaration.initializer
        && ts.isArrayLiteralExpression(unwrap(declaration.initializer, budget));
    } else if (ts.isArrayLiteralExpression(value)) {
      children = [];
      for (const item of value.elements) {
        budget.take();
        if (ts.isSpreadElement(item)) { children = undefined; break; }
        if (!ts.isOmittedExpression(item)) children.push(item);
      }
    } else if (ts.isObjectLiteralExpression(value) && !value.properties.length) safe = true;
    else if (ts.isCallExpression(value)) {
      const coercion = booleanCoercion(value, admission, budget);
      if (coercion && !coercion.input.unknown && nativeBooleanAt(coercion.origin, admission, budget)
        && nativeBooleanHelpers(coercion.origin, admission, budget)) {
        children = [];
        for (const argument of value.arguments) {
          budget.take(); if (ts.isSpreadElement(argument)) { children = undefined; break; } children.push(argument);
        }
      } else {
        const helper = admissionHelper(value, admission, budget);
        if (helper?.trusted) children = [helper.condition];
      }
    }
    if (!children) { memo.set(node, safe); active.delete(node); pending.pop(); continue; }
    frame.children = children;
    for (const child of children) {
      budget.take();
      if (active.has(child)) { memo.set(node, false); break; }
      if (!memo.has(child)) pending.push({ value: child });
    }
  }
  return memo.get(expression)!;
}

function inertReturnGuard(statement: ts.IfStatement, admission: AdmissionIndex, budget: AnalysisBudget): boolean {
  if (!inertGuardExpression(statement.expression, admission, budget)) return false;
  const body = ts.isBlock(statement.thenStatement) ? statement.thenStatement.statements : [statement.thenStatement];
  for (const prefix of body) {
    budget.take();
    if (ts.isReturnStatement(prefix)) return !prefix.expression || inertGuardExpression(prefix.expression, admission, budget);
    if (!inertGuardPrefix(prefix, budget)) return false;
  }
  return false;
}
/** A caught exception before a later guard may resume beyond that guard. */
function inertGuardPrefix(statement: ts.Statement, budget: AnalysisBudget): boolean {
  let memo = inertPrefixMemos.get(budget);
  if (!memo) { memo = new WeakMap(); inertPrefixMemos.set(budget, memo); }
  const literal = (expression: ts.Expression): boolean => {
    const value = unwrap(expression, budget);
    return ts.isNumericLiteral(value) || ts.isBigIntLiteral(value) || ts.isStringLiteralLike(value)
      || value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword || value.kind === ts.SyntaxKind.NullKeyword
      || ts.isArrowFunction(value) || ts.isFunctionExpression(value)
      || ts.isObjectLiteralExpression(value) && !value.properties.length || ts.isArrayLiteralExpression(value) && !value.elements.length;
  };
  const pending = [statement];
  while (pending.length) {
    budget.take(); const node = pending[pending.length - 1];
    if (memo.has(node)) { pending.pop(); continue; }
    let inert = ts.isEmptyStatement(node) || ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node);
    if (ts.isBlock(node)) {
      let ready = true;
      for (const child of node.statements) {
        budget.take();
        if (!memo.has(child)) { pending.push(child); ready = false; }
      }
      if (!ready) continue;
      inert = true;
      for (const child of node.statements) { budget.take(); if (!memo.get(child)) { inert = false; break; } }
    } else if (ts.isExpressionStatement(node)) inert = literal(node.expression);
    else if (ts.isVariableStatement(node)) {
      inert = true;
      for (const declaration of node.declarationList.declarations) {
        budget.take();
        if (!ts.isIdentifier(declaration.name) || declaration.initializer && !literal(declaration.initializer)) { inert = false; break; }
      }
    }
    memo.set(node, inert); pending.pop();
  }
  return memo.get(statement)!;
}
/** Only exits that actually bypass subsequent admission can donate a guard.
 * Nested unconditional blocks and try/finally retain their guards; a catch
 * that resumes execution consumes thrown exits. Summaries share child groups. */
function* prefixExitGuards(statement: ts.Statement, admission: AdmissionIndex, budget: AnalysisBudget): Iterable<ts.IfStatement> {
  let memos = prefixGuardMemos.get(budget);
  if (!memos) { memos = [new WeakMap(), new WeakMap()]; prefixGuardMemos.set(budget, memos); }
  type Task = { node: ts.Statement; throws: boolean; children?: Array<{ node: ts.Statement; throws: boolean }> };
  const pending: Task[] = [{ node: statement, throws: true }];
  while (pending.length) {
    budget.take();
    const task = pending[pending.length - 1], memo = memos[task.throws ? 1 : 0];
    if (memo.has(task.node)) { pending.pop(); continue; }
    if (task.children) {
      const children: PrefixGuardGroup[] = [];
      for (const child of task.children) {
        budget.take();
        const group = memos[child.throws ? 1 : 0].get(child.node)!;
        if (group.guards.length || group.children.length) children.push(group);
      }
      memo.set(task.node, { guards: [], children });
      pending.pop();
      continue;
    }
    if (earlyAdmissionExit(task.node, budget)) {
      memo.set(task.node, { guards: task.throws || admissionExitKind(task.node) === "return"
        && inertReturnGuard(task.node, admission, budget) ? [task.node] : [], children: [] });
      pending.pop();
      continue;
    }
    const children: Task["children"] = [];
    if (ts.isBlock(task.node)) {
      for (const child of task.node.statements) {
        budget.take(); children.push({ node: child, throws: task.throws });
        const mask = statementCompletions(child, budget).mask;
        if (!(mask & NORMAL_COMPLETION) || !task.throws && mask & THROW_COMPLETION) break;
        if (!task.throws && !inertGuardPrefix(child, budget)) break;
      }
    } else if (ts.isTryStatement(task.node)) {
      const final = task.node.finallyBlock && statementCompletions(task.node.finallyBlock, budget).mask;
      const jumps = BREAK_COMPLETION | CONTINUE_COMPLETION | LABELED_BREAK_COMPLETION | LABELED_CONTINUE_COMPLETION;
      if (final === undefined || !(final & jumps)) {
        const caught = task.node.catchClause && statementCompletions(task.node.catchClause.block, budget).mask;
        const escaping = EXIT_COMPLETION | (task.throws ? THROW_COMPLETION : 0);
        const throws = caught === undefined ? task.throws : !(caught & ~escaping);
        children.push({ node: task.node.tryBlock, throws });
      }
      if (task.node.finallyBlock) children.push({ node: task.node.finallyBlock, throws: task.throws });
    } else if (ts.isIfStatement(task.node)) {
      const truth = literalTruth(task.node.expression, budget);
      const branch = truth === true ? task.node.thenStatement : truth === false ? task.node.elseStatement : undefined;
      if (branch) children.push({ node: branch, throws: task.throws });
    }
    task.children = children;
    for (const child of children) { budget.take(); pending.push(child); }
  }
  const groups = [memos[1].get(statement)!];
  while (groups.length) {
    budget.take(); const group = groups.pop()!;
    for (const guard of group.guards) { budget.take(); yield guard; }
    for (let index = group.children.length - 1; index >= 0; index--) { budget.take(); groups.push(group.children[index]); }
  }
}

/** Reuse non-nullish result proofs without assuming that opaque calls return
 * Booleans. Native coercions and trusted predicate helpers retain their type. */
function guardNullish(expression: ts.Expression, admission: AdmissionIndex, budget: AnalysisBudget): boolean | undefined {
  const path = new Set<ts.Expression>();
  let result: boolean | undefined;
  for (;;) {
    budget.take();
    const normalized = admission.guardExpressions.get(expression) ?? unwrap(expression, budget);
    admission.guardExpressions.set(expression, normalized); expression = normalized;
    const cached = admission.guardNullish.get(expression);
    if (cached !== undefined) { result = cached ?? undefined; break; }
    if (path.has(expression)) break;
    path.add(expression);
    result = literalNullish(expression, budget);
    if (result !== undefined || !ts.isCallExpression(expression)) break;
    const coercion = booleanCoercion(expression, admission, budget);
    if (coercion) {
      if (nativeBooleanAt(coercion.origin, admission, budget) && nativeBooleanHelpers(coercion.origin, admission, budget)) result = false;
      break;
    }
    const helper = admissionHelper(expression, admission, budget);
    if (!helper?.trusted) break;
    expression = helper.condition;
  }
  for (const value of path) { budget.take(); admission.guardNullish.set(value, result ?? null); }
  return result;
}

/** Native constant coercions can make the following enqueue unreachable. */
function admissionTruth(expression: ts.Expression, admission: AdmissionIndex, budget: AnalysisBudget): boolean | undefined {
  const seen = new Set<ts.Expression>(), path: Array<{ value: ts.Expression; negate: boolean }> = [];
  let negate = false, result: boolean | undefined;
  for (;;) {
    budget.take();
    const normalized = admission.guardExpressions.get(expression) ?? unwrap(expression, budget);
    admission.guardExpressions.set(expression, normalized); expression = normalized;
    const cached = admission.guardTruth.get(expression);
    if (cached !== undefined) { result = cached === null ? undefined : cached !== negate; break; }
    if (seen.has(expression)) break;
    seen.add(expression); path.push({ value: expression, negate });
    const truth = literalTruth(expression, budget);
    if (truth !== undefined) { result = truth !== negate; break; }
    if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
      negate = !negate; expression = expression.operand; continue;
    }
    if (!ts.isCallExpression(expression)) break;
    const coercion = booleanCoercion(expression, admission, budget);
    if (coercion) {
      if (coercion.input.unknown || !nativeBooleanAt(coercion.origin, admission, budget)
        || !nativeBooleanHelpers(coercion.origin, admission, budget)) break;
      if (!coercion.input.value) { result = negate; break; }
      expression = coercion.input.value;
    } else {
      const helper = admissionHelper(expression, admission, budget);
      if (!helper?.trusted) break;
      expression = helper.condition;
    }
  }
  for (const item of path) { budget.take(); admission.guardTruth.set(item.value, result === undefined ? null : result !== item.negate); }
  return result;
}

function immutableBinding(expression: ts.Expression, budget: AnalysisBudget): ts.Symbol | undefined {
  const value = unwrap(expression, budget);
  const symbol = ts.isIdentifier(value) ? symbolOf(value) : undefined;
  const declaration = symbol?.valueDeclaration;
  return declaration && ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const
    ? symbol : undefined;
}

function remainingCapacity(expression: ts.Expression, budget: AnalysisBudget, startup?: ts.Statement,
  dependency?: GuardAvailability): ts.Symbol | undefined {
  const value = unwrap(expression, budget);
  if (!ts.isBinaryExpression(value) || value.operatorToken.kind !== ts.SyntaxKind.MinusToken
    || !finiteCap(value.left, budget, startup, dependency)) return undefined;
  return readCounter(value.right, budget);
}

function readCounter(expression: ts.Expression, budget: AnalysisBudget): ts.Symbol | undefined {
  const value = unwrap(expression, budget);
  if (ts.isIdentifier(value)) return mutableCounter(value, budget);
  const receiver = namedAccess(value, "length");
  const symbol = receiver && ts.isIdentifier(receiver) ? symbolOf(receiver) : undefined;
  return symbol && privateQueues.get(budget)?.has(symbol) ? symbol : undefined;
}

function initialCounter(counter: ts.Symbol, budget: AnalysisBudget): number | undefined {
  if (privateQueues.get(budget)?.has(counter)) return 0;
  const declaration = counter.valueDeclaration;
  return declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
    ? singletonLoopValue(declaration.initializer, budget) : undefined;
}

function mutableCounter(expression: ts.Expression, budget: AnalysisBudget): ts.Symbol | undefined {
  const counter = unwrap(expression, budget);
  let symbol = ts.isIdentifier(counter) ? symbolOf(counter) : undefined;
  let declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (declaration && ts.isImportSpecifier(declaration)) {
    declaration = definitionOf(counter);
    if (declaration && ts.isVariableDeclaration(declaration)) symbol = symbolOf(declaration.name);
  }
  return declaration && ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
    && !(declaration.parent.flags & ts.NodeFlags.Const) && ts.isVariableStatement(declaration.parent.parent)
    && ts.isSourceFile(declaration.parent.parent.parent) ? symbol : undefined;
}

function finiteCap(expression: ts.Expression, budget: AnalysisBudget, startup?: ts.Statement,
  dependency?: GuardAvailability): boolean {
  const seen = new Set<ts.Symbol>();
  let value = unwrap(expression, budget);
  while (ts.isIdentifier(value)) {
    budget.take();
    const binding = immutableBinding(value, budget);
    const declaration = binding?.valueDeclaration;
    if (!binding || seen.has(binding) || !declaration || !ts.isVariableDeclaration(declaration)
      || !declaration.initializer) return false;
    if (declaration.end > value.pos) {
      // Preserve the initialization boundary while sharing later registrations
      // that observe the same immutable binding. Missing/unrelated startup
      // scopes have a separate cache and cannot satisfy this lookup.
      if (dependency) dependency.scoped = true;
      if (!startup || !ts.isVariableStatement(declaration.parent.parent)
        || declaration.parent.parent.parent !== startup.parent) return false;
      if (declaration.end > startup.pos) {
        if (dependency) dependency.before = Math.min(dependency.before, declaration.end);
        return false;
      }
      if (dependency) dependency.after = Math.max(dependency.after, declaration.end);
    }
    seen.add(binding);
    // A captured name is read by the helper at invocation. Any alias initializer
    // was evaluated at its own declaration, so use lexical order for that read.
    startup = undefined;
    value = unwrap(declaration.initializer, budget);
  }
  return ts.isNumericLiteral(value) && Number.isSafeInteger(Number(value.text));
}

interface BatchClamp { fixed: boolean; remaining: Set<ts.Symbol>; call: ts.CallExpression }
function batchClamp(expression: ts.Expression, cache: WeakMap<ts.Expression, BatchClamp | null>, budget: AnalysisBudget): BatchClamp | undefined {
  if (cache.has(expression)) return cache.get(expression) ?? undefined;
  let value = unwrap(expression, budget);
  const seen = new Set<ts.Symbol>();
  const traversed = [expression];
  const finish = (result?: BatchClamp): BatchClamp | undefined => {
    for (const node of traversed) { budget.take(); cache.set(node, result ?? null); }
    return result;
  };
  while (ts.isIdentifier(value)) {
    budget.take();
    const symbol = immutableBinding(value, budget);
    if (!symbol || seen.has(symbol)) return finish();
    seen.add(symbol);
    const declaration = symbol.valueDeclaration as ts.VariableDeclaration;
    if (!declaration.initializer) return finish();
    if (cache.has(declaration.initializer)) return finish(cache.get(declaration.initializer) ?? undefined);
    traversed.push(declaration.initializer);
    value = unwrap(declaration.initializer, budget);
  }
  if (!ts.isCallExpression(value) || value.questionDotToken || !ts.isPropertyAccessExpression(value.expression)
    || value.expression.questionDotToken || value.expression.name.text !== "min"
    || !ts.isIdentifier(value.expression.expression) || value.expression.expression.text !== "Math"
    || !hostIdentifier(value.expression.expression)) return finish();
  let fixed = false;
  const remaining = new Set<ts.Symbol>();
  for (const argument of value.arguments) {
    budget.take();
    const counter = remainingCapacity(argument, budget);
    if (counter) remaining.add(counter);
    fixed ||= finiteCap(argument, budget);
  }
  return finish(fixed || remaining.size ? { fixed, remaining, call: value } : undefined);
}

function callAdmission(call: ts.CallExpression | ts.NewExpression, admission: AdmissionIndex,
  budget: AnalysisBudget, at = call.end): AdmissionFacts | undefined {
  let expression: ts.Node = call;
  let facts = admission.get(expression);
  const path: ts.Node[] = [];
  while (!facts) {
    const parent: ts.Node = expression.parent;
    if (ts.isFunctionLike(parent) || ts.isClassExpression(parent)
      || !(ts.isExpression(parent) || ts.isPropertyAssignment(parent) || ts.isSpreadAssignment(parent)
        || ts.isComputedPropertyName(parent) || ts.isTemplateSpan(parent) || ts.isBindingElement(parent)
        || ts.isArrayBindingPattern(parent) || ts.isObjectBindingPattern(parent) || ts.isVariableDeclaration(parent)
        || ts.isVariableDeclarationList(parent))) break;
    budget.take();
    path.push(expression);
    expression = parent;
    facts = admission.get(expression);
  }
  if (!facts) {
    const use = expression.parent;
    if (ts.isArrowFunction(use) && use.body === expression || ts.isParameter(use)) {
      const async = ts.isArrowFunction(use) && use.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword);
      facts = { state: "open", lastSuspension: -1, async, awaitEnds: async ? awaitEnds(expression, budget) : [] };
    } else {
      const statement = ts.isVariableStatement(use) || ts.isExpressionStatement(use) || ts.isReturnStatement(use)
        || ts.isThrowStatement(use) || ts.isIfStatement(use) || ts.isSwitchStatement(use) || ts.isIterationStatement(use, false) ? use : undefined;
      if (!statement) return undefined;
      facts = statementAdmission(statement, admission, budget);
      if (!facts) return undefined;
      if (!facts.unreachable && ts.isIterationStatement(statement, false)) {
        const once = ts.isForStatement(statement) && expression === statement.initializer
          || (ts.isForOfStatement(statement) || ts.isForInStatement(statement)) && expression === statement.expression;
        const evaluated: ts.Node[] = [];
        if (!once && ts.isForStatement(statement)) {
          if (statement.initializer) evaluated.push(statement.initializer);
          if (expression === statement.incrementor) {
            if (statement.condition) evaluated.push(statement.condition);
            evaluated.push(statement.statement);
          }
        } else if (ts.isDoStatement(statement)) evaluated.push(statement.statement);
        else if (!once && (ts.isForInStatement(statement) || ts.isForOfStatement(statement))) evaluated.push(statement.expression);
        const boundary = !once && ts.isForOfStatement(statement) && statement.awaitModifier ? expression.pos
          : once ? undefined : loopAdmissionBoundary(statement, admission.loopWrites, facts.async, budget);
        const entry = childAdmission(facts, evaluated, false, budget, boundary === undefined ? undefined : Math.min(expression.pos, boundary));
        if (ts.isForStatement(statement) && expression === statement.incrementor && statement.condition) {
          applyBranchCapacity(statement, true, entry, facts, admission, budget);
        }
        facts = entry;
      }
      if (facts.async && !facts.unreachable && !facts.suspensionIndexed) {
        facts.awaitEnds = awaitEnds(ts.isIterationStatement(statement, false) ? expression
          : ts.isIfStatement(statement) || ts.isSwitchStatement(statement) ? statement.expression : statement, budget);
        facts.suspensionIndexed = true;
      }
    }
    admission.set(expression, facts);
  }
  while (path.length) {
    budget.take();
    const child = path.pop()!;
    if (facts.async && ts.isVariableDeclaration(expression) && child === expression.name && expression.initializer
      && awaitEnds(expression.initializer, budget).length) {
      // The RHS runs before destructuring keys and defaults despite its later source position.
      facts = { ...facts, state: "resumed", lastSuspension: child.pos, capacitySegment: undefined };
    }
    const logical = ts.isBinaryExpression(expression) && expression.right === child ? expression.operatorToken.kind : undefined;
    const branch = ts.isConditionalExpression(expression) && child !== expression.condition ? expression
      : logical === ts.SyntaxKind.AmpersandAmpersandToken || logical === ts.SyntaxKind.BarBarToken
        || logical === ts.SyntaxKind.QuestionQuestionToken ? expression as ts.BinaryExpression : undefined;
    if (branch && !facts.unreachable) {
      const condition = guardCondition(branch);
      const prior = admissionAt(facts, condition.end + 1, budget);
      const enterThen = ts.isConditionalExpression(branch) ? child === branch.whenTrue : logical === ts.SyntaxKind.AmpersandAmpersandToken;
      const nullish = logical === ts.SyntaxKind.QuestionQuestionToken;
      const selected = nullish ? guardNullish(condition, admission, budget) : admissionTruth(condition, admission, budget);
      facts = { ...prior, awaitStart: child.pos, block: undefined, capacitySegment: undefined };
      if (selected !== undefined && selected !== (nullish || enterThen)) facts.unreachable = true;
      else if (!nullish && selected === undefined) {
        if (facts.state === "open") facts.state = "guarded";
        applyBranchCapacity(branch, enterThen, facts, prior, admission, budget);
      }
    }
    expression = child;
    admission.set(child, facts);
  }
  return admissionAt(facts, at, budget);
}

function applyBranchCapacity(site: GuardSite, enterThen: boolean, child: AdmissionFacts, parent: AdmissionFacts,
  admission: AdmissionIndex, budget: AnalysisBudget): void {
  const condition = guardCondition(site);
  const after = child.lastSuspension >= condition.pos ? child.lastSuspension : undefined;
  const checks = capacityCountSymbols(site, budget, admission, enterThen, after);
  if (!checks.length) return;
  if (child.state === "open") child.state = "guarded";
  child.enclosing = parent;
  child.before = condition.end + 1;
  child.capacityChecks = new Map();
  child.capacityGuards = new Map();
  child.capacityMentions = new Map();
  child.uncertainCapacity = new Map();
  child.scalarCapacity = new Map();
  child.barrierChecks = new Map();
  for (const [count, counter, evidence] of checks) recordCapacity(child, count, counter, evidence, condition.end, budget);
  recordScalarCapacity(site, child, admission, budget, enterThen);
}

function statementAdmission(statement: ts.Statement, admission: AdmissionIndex,
  budget: AnalysisBudget): AdmissionFacts | undefined {
  let facts = admission.get(statement);
  if (facts) return facts;
  const path: Array<{ statement: ts.Statement; scope: ts.Node }> = [];
  for (let current = statement; !facts;) {
    budget.take();
    const scope: ts.Node = current.parent;
    path.push({ statement: current, scope });
    if (ts.isBlock(scope) && ts.isFunctionLike(scope.parent)) {
      facts = admission.get(scope);
      if (!facts) {
        facts = {
          state: "open", awaitEnds: [], lastSuspension: -1,
          async: ts.canHaveModifiers(scope.parent) && ts.getModifiers(scope.parent)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword),
        };
        admission.set(scope, facts);
      }
      break;
    }
    if (ts.isCaseClause(scope) || ts.isDefaultClause(scope)) current = scope.parent.parent;
    else if (ts.isCatchClause(scope)) current = scope.parent;
    else if (ts.isBlock(scope) || ts.isIfStatement(scope) || ts.isTryStatement(scope) || ts.isLabeledStatement(scope) || ts.isIterationStatement(scope, false)) current = scope;
    else return undefined;
    facts = admission.get(current);
  }

  while (path.length) {
    budget.take();
    const step = path.pop()!;
    const known = admission.get(step.statement);
    if (known) { facts = known; continue; }
    const scope = step.scope;
    if (facts.unreachable || ts.isStatement(scope) && skippedAdmissionLoop(scope, budget)) {
      if (!facts.unreachable) facts = { ...facts, unreachable: true };
      admission.set(step.statement, facts);
    } else if (ts.isBlock(scope)) facts = nextAdmission(step.statement, scope, facts, admission, budget);
    else if (ts.isCaseClause(scope) || ts.isDefaultClause(scope)) {
      if (!admission.has(scope)) indexSwitchAdmission(scope.parent.parent, facts, admission, budget);
      const entry = admission.get(scope)!;
      facts = entry.unreachable ? entry : nextAdmission(step.statement, scope, entry, admission, budget);
    } else {
      const entry = scopeEntry(scope, step.statement, facts.async, admission.loopWrites, budget);
      const child = childAdmission(facts, entry.evaluated, entry.conditional, budget, entry.implicitAwait);
      if (ts.isIfStatement(scope) && entry.conditional) {
        applyBranchCapacity(scope, step.statement === scope.thenStatement, child, facts, admission, budget);
      } else if (ts.isWhileStatement(scope) || ts.isForStatement(scope) && scope.condition) {
        applyBranchCapacity(scope, true, child, facts, admission, budget);
      }
      facts = child;
      admission.set(step.statement, facts);
    }
  }
  return facts;
}

function switchLiteral(node: ts.Expression, budget: AnalysisBudget): string | number | bigint | boolean | null | undefined {
  let expression = unwrap(node, budget);
  let negative = false;
  if (ts.isPrefixUnaryExpression(expression)) {
    negative = expression.operator === ts.SyntaxKind.MinusToken;
    if (!negative && expression.operator !== ts.SyntaxKind.PlusToken) return undefined;
    expression = unwrap(expression.operand, budget);
    if (ts.isNumericLiteral(expression)) return negative ? -Number(expression.text) : Number(expression.text);
    if (!negative || !ts.isBigIntLiteral(expression)) return undefined;
  }
  if (ts.isBigIntLiteral(expression)) {
    try {
      const value = BigInt(expression.text.slice(0, -1));
      return negative ? -value : value;
    } catch {
      return undefined;
    }
  }
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  return expression.kind === ts.SyntaxKind.NullKeyword ? null : undefined;
}

type SwitchDispatch = {
  tests: ts.Expression[];
  direct: Map<ts.CaseOrDefaultClause, number>;
  unmatched: boolean;
};

const switchDispatches = new WeakMap<AnalysisBudget, WeakMap<ts.SwitchStatement, SwitchDispatch>>();

function switchDispatch(statement: ts.SwitchStatement, budget: AnalysisBudget): SwitchDispatch {
  let dispatches = switchDispatches.get(budget);
  if (!dispatches) { dispatches = new WeakMap(); switchDispatches.set(budget, dispatches); }
  const cached = dispatches.get(statement);
  if (cached) return cached;
  const tests: ts.Expression[] = [];
  const direct = new Map<ts.CaseOrDefaultClause, number>();
  const discriminant = switchLiteral(statement.expression, budget);
  let fallback: ts.DefaultClause | undefined;
  let searchOpen = true;
  const literalCases = new Set<Exclude<ReturnType<typeof switchLiteral>, undefined>>();
  for (const clause of statement.caseBlock.clauses) {
    budget.take();
    if (ts.isDefaultClause(clause)) { fallback = clause; continue; }
    tests.push(clause.expression);
    const value = switchLiteral(clause.expression, budget);
    const duplicate = value !== undefined && literalCases.has(value);
    if (value !== undefined) literalCases.add(value);
    if (!duplicate && (discriminant === undefined || value === undefined || discriminant === value)) direct.set(clause, tests.length);
    if (discriminant !== undefined && discriminant === value) {
      searchOpen = false;
      break;
    }
  }
  // Default is selected only after all remaining tests fail, including tests
  // written after its body. Falling through never evaluates another test.
  if (searchOpen && fallback) direct.set(fallback, tests.length);
  const dispatch = { tests, direct, unmatched: searchOpen && !fallback };
  dispatches.set(statement, dispatch);
  return dispatch;
}

function indexSwitchAdmission(statement: ts.SwitchStatement, facts: AdmissionFacts,
  admission: AdmissionIndex, budget: AnalysisBudget): void {
  const selected = childAdmission(facts, [statement.expression], false, budget);
  const clauses = statement.caseBlock.clauses;
  const dispatch = switchDispatch(statement, budget);
  let suspensionAt = Infinity;
  if (facts.async) for (const [index, test] of dispatch.tests.entries()) {
    budget.take();
    if (awaitEnds(test, budget).length) { suspensionAt = index + 1; break; }
  }
  const direct = dispatch.direct;
  let previous: ts.CaseOrDefaultClause | undefined;
  let fallthroughEntry: AdmissionFacts | undefined;
  let fallthroughSuspended = false;
  for (const clause of clauses) {
    budget.take();
    const reachable: boolean = direct.has(clause) || previous !== undefined;
    const suspended: boolean = (direct.get(clause) ?? 0) >= suspensionAt || fallthroughSuspended;
    // On either incoming path the suspension preceded this clause's local
    // statements, even when the tested expression appears after default.
    // A fallthrough-only entry also retains the preceding clause's admission
    // checks. A direct match can bypass them, so at a merge keep only search facts.
    const entry = previous && fallthroughEntry && !direct.has(clause)
      ? childAdmission(nextAdmission(undefined, previous, fallthroughEntry, admission, budget), [], false, budget)
      : childAdmission(selected, [], false, budget, suspended ? clause.statements.pos : undefined);
    if (!reachable) entry.unreachable = true;
    admission.set(clause, entry);
    previous = reachable ? clause : undefined;
    fallthroughEntry = reachable ? entry : undefined;
    fallthroughSuspended = reachable && suspended;
    if (!reachable) continue;
    for (const child of clause.statements) {
      budget.take();
      if (!(statementCompletions(child, budget).mask & NORMAL_COMPLETION)) {
        previous = undefined;
        fallthroughEntry = undefined;
        fallthroughSuspended = false;
        break;
      }
      if (facts.async && !fallthroughSuspended) fallthroughSuspended = awaitEnds(child, budget, true).length > 0;
    }
  }
}

function singletonLoopValue(node: ts.Expression, budget: AnalysisBudget): number | undefined {
  const expression = unwrap(node, budget);
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  if (ts.isPrefixUnaryExpression(expression) && ts.isNumericLiteral(expression.operand)) {
    if (expression.operator === ts.SyntaxKind.MinusToken) return -Number(expression.operand.text);
    if (expression.operator === ts.SyntaxKind.PlusToken) return Number(expression.operand.text);
  }
  return undefined;
}

function loopHasWrite(positions: number[] | undefined, body: ts.Statement, sorted: WeakSet<number[]>,
  budget: AnalysisBudget): boolean {
  if (!positions) return false;
  if (!sorted.has(positions)) {
    positions.sort((left, right) => { budget.take(); return left - right; });
    sorted.add(positions);
  }
  const first = firstAfter(positions, body.pos - 1, budget);
  return first !== undefined && first < body.end;
}

function loopCardinality(loop: ts.IterationStatement, writes: LoopWrites, budget: AnalysisBudget): "once" | "fixed" | undefined {
  if (ts.isForOfStatement(loop)) {
    const iterable = unwrap(loop.expression, budget);
    if (!ts.isArrayLiteralExpression(iterable)) return undefined;
    for (const element of iterable.elements) { budget.take(); if (ts.isSpreadElement(element)) return undefined; }
    return iterable.elements.length <= 1 ? "once" : "fixed";
  }
  if (!ts.isForStatement(loop) || !loop.initializer || !ts.isVariableDeclarationList(loop.initializer)
    || !(loop.initializer.flags & ts.NodeFlags.Let) || loop.initializer.declarations.length !== 1
    || !loop.condition || !loop.incrementor) return undefined;
  const declaration = loop.initializer.declarations[0];
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return undefined;
  const symbol = symbolOf(declaration.name);
  const condition = unwrap(loop.condition, budget);
  const increment = unwrap(loop.incrementor, budget);
  if (!symbol || !ts.isBinaryExpression(condition)
    || !(condition.operatorToken.kind === ts.SyntaxKind.LessThanToken || condition.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken)
    || !ts.isIdentifier(condition.left) || symbolOf(condition.left) !== symbol
    || !(ts.isPrefixUnaryExpression(increment) || ts.isPostfixUnaryExpression(increment))
    || increment.operator !== ts.SyntaxKind.PlusPlusToken || !ts.isIdentifier(increment.operand)
    || symbolOf(increment.operand) !== symbol) return undefined;
  const startValue = singletonLoopValue(declaration.initializer, budget), endValue = singletonLoopValue(condition.right, budget);
  if (startValue === undefined || endValue === undefined || !Number.isSafeInteger(startValue) || !Number.isSafeInteger(endValue)) return undefined;
  // The shared write scan indexes exact bindings, including writes in nested
  // closures and destructuring. Read-only descendants do not need rescanning.
  if (loopHasWrite(writes.bindings.get(symbol), loop.statement, writes.sorted, budget)
    || loopHasWrite(writes.evals.get(loop.getSourceFile()), loop.statement, writes.sorted, budget)) return undefined;
  return endValue - startValue <= (condition.operatorToken.kind === ts.SyntaxKind.LessThanToken ? 1 : 0) ? "once" : "fixed";
}

function loopAdmissionBoundary(loop: ts.IterationStatement, writes: LoopWrites, async: boolean | undefined, budget: AnalysisBudget): number | undefined {
  const labeled = ts.isLabeledStatement(loop.parent) ? loop : undefined;
  const repeats = NORMAL_COMPLETION | CONTINUE_COMPLETION | (labeled ? LABELED_CONTINUE_COMPLETION : 0);
  const condition = loopCondition(loop);
  if (skippedAdmissionLoop(loop, budget) || condition && literalTruth(condition, budget) === false) return undefined;
  const count = loopCardinality(loop, writes, budget);
  if (count === "once" || !async && count === "fixed"
    || !allowsCompletion(statementCompletions(loop.statement, budget), repeats, budget, undefined, labeled && [labeled])) return undefined;
  if (ts.isForOfStatement(loop) && awaitUsing(loop.initializer)) return loop.statement.pos;
  // One check outside a request-sized batch cannot bound all its pushes.
  // A condition tested before every iteration can establish fresh admission.
  if (!count) return condition && !ts.isDoStatement(loop) ? condition.pos : loop.statement.pos;
  const tail = ts.isForStatement(loop) ? loop.incrementor : ts.isDoStatement(loop) ? loop.expression : undefined;
  // An earlier iteration ends before this iteration's local guards run.
  return awaitEnds(loop.statement, budget, false, repeats, labeled, repeatedAwaitSearch(budget)).length
    || tail && awaitEnds(tail, budget).length
    ? loop.statement.pos : undefined;
}

function scopeEntry(scope: ts.Node, child: ts.Statement, async: boolean | undefined, writes: LoopWrites, budget: AnalysisBudget): {
  evaluated: ts.Node[]; conditional: boolean; implicitAwait?: number;
} {
  if (ts.isIfStatement(scope)) {
    return { evaluated: [scope.expression], conditional: literalTruth(scope.expression, budget) === undefined };
  }
  if (ts.isTryStatement(scope)) {
    const evaluated: ts.Node[] = [];
    if (child === scope.finallyBlock) {
      evaluated.push(scope.tryBlock);
      if (scope.catchClause) evaluated.push(scope.catchClause.block);
    }
    return { evaluated, conditional: false };
  }
  if (ts.isCatchClause(scope)) return { evaluated: [scope.parent.tryBlock], conditional: false };
  const repeated = ts.isIterationStatement(scope, false) ? loopAdmissionBoundary(scope, writes, async, budget) : undefined;
  if (ts.isForStatement(scope)) return {
    evaluated: [scope.initializer, scope.condition].filter((node): node is ts.Expression | ts.VariableDeclarationList => !!node),
    conditional: false, implicitAwait: repeated,
  };
  if (ts.isWhileStatement(scope)) return { evaluated: [scope.expression], conditional: false, implicitAwait: repeated };
  if (ts.isForOfStatement(scope) || ts.isForInStatement(scope)) return {
    evaluated: [scope.expression, ...loopBindingEvaluations(scope, budget)], conditional: false,
    implicitAwait: ts.isForOfStatement(scope) && scope.awaitModifier ? scope.expression.end : repeated,
  };
  return { evaluated: [], conditional: false, implicitAwait: repeated };
}

function childAdmission(facts: AdmissionFacts, evaluated: ts.Node[], conditional: boolean, budget: AnalysisBudget,
  implicitAwait?: number): AdmissionFacts {
  let suspension = implicitAwait;
  if (facts.async) for (const node of evaluated) {
    budget.take();
    const end = awaitEnds(node, budget).at(-1);
    if (end !== undefined) suspension = Math.max(suspension ?? -1, end);
  }
  const state = suspension !== undefined ? "resumed" : conditional && facts.state === "open" ? "guarded" : facts.state;
  return {
    ...facts, awaitEnds: [], block: undefined, suspensionIndexed: false,
    capacitySegment: undefined,
    state, lastSuspension: Math.max(suspension ?? -1, facts.lastSuspension),
  };
}

function nextAdmission(statement: ts.Statement | undefined, block: ts.Block | ts.CaseClause | ts.DefaultClause, enclosing: AdmissionFacts,
  admission: AdmissionIndex, budget: AnalysisBudget): AdmissionFacts {
  const scope = enclosing.block ??= {
    index: 0, state: enclosing.state, unreachable: enclosing.unreachable, lastSuspension: enclosing.lastSuspension,
    capacityChecks: new Map(), capacityGuards: new Map(), capacityMentions: new Map(), uncertainCapacity: new Map(), scalarCapacity: new Map(),
    barrierChecks: new Map(), capacitySegment: {},
    appliedChecks: new WeakSet(),
  };
  const prefixFacts = (prefix: ts.Statement): AdmissionFacts => {
    let facts = admission.get(prefix);
    if (!facts) {
      facts = {
        state: scope.state, unreachable: scope.unreachable, awaitEnds: [], lastSuspension: scope.lastSuspension, before: prefix.pos + 1,
        capacityChecks: scope.capacityChecks, capacityGuards: scope.capacityGuards, capacityMentions: scope.capacityMentions,
        uncertainCapacity: scope.uncertainCapacity, scalarCapacity: scope.scalarCapacity, barrierChecks: scope.barrierChecks,
        capacitySegment: scope.capacitySegment, enclosing, async: enclosing.async,
      };
      admission.set(prefix, facts);
    }
    return facts;
  };
  while (scope.index < block.statements.length) {
    budget.take();
    const prefix = block.statements[scope.index];
    if (prefix === statement) return prefixFacts(prefix);
    prefixFacts(prefix);
    scope.index++;
    // Only continuing paths can contribute a stale admission check to later siblings.
    const suspension = enclosing.async ? awaitEnds(prefix, budget, true).at(-1) : undefined;
    if (suspension !== undefined) {
      scope.state = "resumed";
      scope.lastSuspension = suspension;
      scope.capacitySegment = {};
      scope.appliedChecks = new WeakSet();
      // A later operand of an early-exit condition can recheck capacity after
      // resumption. Its earlier operands cannot donate fresh observations.
      if (!earlyAdmissionExit(prefix, budget)) continue;
    }
    if (ts.isExpressionStatement(prefix) || ts.isVariableStatement(prefix) || ts.isEmptyStatement(prefix)
      || ts.isFunctionDeclaration(prefix) || skippedAdmissionLoop(prefix, budget)
      || ts.isIfStatement(prefix) && !prefix.elseStatement && literalTruth(prefix.expression, budget) === false
      || !hasFlowEffect(prefix, budget)
      || !(statementCompletions(prefix, budget).mask & ~NORMAL_COMPLETION)) continue;
    if (scope.state !== "resumed" && scope.state !== "guarded") {
      scope.state = "guarded";
      scope.capacitySegment = {};
    }
    for (const guard of prefixExitGuards(prefix, admission, budget)) {
      if (admissionTruth(guard.expression, admission, budget) === true) scope.unreachable = true;
      if (recordScalarCapacity(guard, scope, admission, budget)) scope.capacitySegment = {};
      const after = scope.lastSuspension >= guard.expression.pos ? scope.lastSuspension : undefined;
      const capacity = capacityCountSymbols(guard, budget, admission, false, after);
      if (scope.appliedChecks.has(capacity)) continue;
      scope.appliedChecks.add(capacity);
      for (const [count, counter, evidence] of capacity) {
        budget.take();
        if (recordCapacity(scope, count, counter, evidence, guard.end, budget)) scope.capacitySegment = {};
      }
    }
  }
  return statement ? prefixFacts(statement) : {
    state: scope.state, unreachable: scope.unreachable, awaitEnds: [], lastSuspension: scope.lastSuspension, before: block.end + 1,
    capacityChecks: scope.capacityChecks, capacityGuards: scope.capacityGuards, capacityMentions: scope.capacityMentions,
    uncertainCapacity: scope.uncertainCapacity, scalarCapacity: scope.scalarCapacity, barrierChecks: scope.barrierChecks,
    capacitySegment: scope.capacitySegment, enclosing, async: enclosing.async,
  };
}

/** Keep independently effective scalar gates apart from rejected Boolean
 * wrappers. Unit cardinality prevents an equality gate from being skipped. */
function recordScalarCapacity(statement: GuardSite,
  facts: Pick<AdmissionFacts, "scalarCapacity" | "uncertainCapacity" | "barrierChecks" | "lastSuspension">, admission: AdmissionIndex,
  budget: AnalysisBudget, enterThen = false): boolean {
  const expression = guardCondition(statement);
  const after = facts.lastSuspension >= expression.pos ? facts.lastSuspension : undefined;
  const barrier = scalarBarrier(expression, admission, budget, enterThen, after);
  if (!barrier || !admission.scalarCandidates.has(barrier.counter)) return false;
  const { counter } = barrier;
  const checks = facts.barrierChecks ??= new Map();
  let values = checks.get(counter);
  if (!values) { values = []; checks.set(counter, values); }
  let seen = admission.barrierSeen.get(values);
  if (!seen) { seen = new Map(); admission.barrierSeen.set(values, seen); }
  const signature = barrier.operator === "and" || barrier.operator === "or" ? barrier : `${barrier.operator}:${barrier.limit}`;
  const prior = seen.get(signature);
  const changed = prior === undefined || prior <= facts.lastSuspension;
  if (changed) {
    budget.take();
    values.push({ barrier, position: expression.end });
    seen.set(signature, expression.end);
  }
  let records = admission.scalarRecords.get(counter);
  if (!records) { records = { arrays: new Map() }; admission.scalarRecords.set(counter, records); }
  // Seeing a scalar policy requires precise admission even when that policy
  // cannot supply a proof (a batch can skip equality, and fractional equality
  // is never reached by an integer counter). Do not let generic guard handling
  // resurrect either case after the queue-wide check fails.
  const uncertain = facts.uncertainCapacity ??= new Map();
  const priorUncertain = uncertain.get(counter);
  if (!priorUncertain) uncertain.set(counter, [expression.end]);
  else if (priorUncertain.at(-1)! <= facts.lastSuspension) priorUncertain.push(expression.end);
  if (barrier.operator !== "equal" && barrier.operator !== "truthy") return changed;
  const initial = initialCounter(counter, budget);
  const cap = barrier.operator === "truthy" ? Math.max(1, initial ?? 0) : barrier.limit;
  if (cap === undefined || initial === undefined || !Number.isSafeInteger(cap) || initial > cap) return changed;
  const owner = callOwner(statement, admission.scalarOwnerCache, budget);
  if (!owner || !admission.scalarUnitOwners?.(counter).has(owner)) return changed;
  const marks = facts.scalarCapacity ??= new Map();
  const positions = marks.get(counter);
  const evidence = positions && records.arrays.get(positions);
  const freshTruth = barrier.operator === "truthy" && evidence
    && evidence.lastTruthy <= facts.lastSuspension;
  if (positions?.at(-1)! > facts.lastSuspension && !freshTruth) return changed;
  if (positions) {
    positions.push(expression.end);
    if (barrier.operator === "truthy") {
      evidence!.truthy.add(expression.end);
      evidence!.lastTruthy = expression.end;
    }
  }
  else {
    const added = [expression.end];
    marks.set(counter, added);
    records.arrays.set(added, { uncertain: facts.uncertainCapacity ??= new Map(),
      truthy: new Set(barrier.operator === "truthy" ? added : []),
      lastTruthy: barrier.operator === "truthy" ? expression.end : -1 });
  }
  return true;
}

function recordCapacity(scope: Pick<AdmissionFacts, "capacityChecks" | "capacityMentions" | "uncertainCapacity" | "capacityGuards" | "lastSuspension">,
  count: ts.Symbol | undefined, counter: ts.Symbol, evidence: CapacityEvidence, position: number, budget: AnalysisBudget): boolean {
  budget.take();
  let marks = evidence === "bound" ? scope.capacityChecks! : evidence === "mention" ? scope.capacityMentions! : scope.uncertainCapacity!;
  if (count && evidence === "bound") {
    marks = scope.capacityGuards!.get(count) ?? new Map();
    scope.capacityGuards!.set(count, marks);
  }
  const positions = marks.get(counter);
  // A repeated check in the same synchronous segment already proves the same
  // capacity, and preserving its position keeps earlier users of the map valid.
  if (positions && positions[positions.length - 1] > scope.lastSuspension) return false;
  if (positions) positions.push(position);
  else marks.set(counter, [position]);
  return true;
}

function skippedAdmissionLoop(statement: ts.Statement, budget: AnalysisBudget): boolean {
  if (ts.isWhileStatement(statement)) return literalTruth(statement.expression, budget) === false;
  if (ts.isForOfStatement(statement)) {
    const iterable = unwrap(statement.expression, budget);
    return ts.isArrayLiteralExpression(iterable) && !iterable.elements.length;
  }
  if (!ts.isForStatement(statement) || !statement.condition) return false;
  if (literalTruth(statement.condition, budget) === false) return true;
  const initializer = statement.initializer;
  if (!initializer || !ts.isVariableDeclarationList(initializer) || initializer.declarations.length !== 1) return false;
  const declaration = initializer.declarations[0];
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return false;
  const condition = unwrap(statement.condition, budget);
  if (!ts.isBinaryExpression(condition) || !ts.isIdentifier(condition.left)) return false;
  const binding = symbolOf(declaration.name);
  if (!binding || symbolOf(condition.left) !== binding) return false;
  const start = singletonLoopValue(declaration.initializer, budget);
  const end = singletonLoopValue(condition.right, budget);
  if (start === undefined || end === undefined) return false;
  switch (condition.operatorToken.kind) {
    case ts.SyntaxKind.LessThanToken: return start >= end;
    case ts.SyntaxKind.LessThanEqualsToken: return start > end;
    case ts.SyntaxKind.GreaterThanToken: return start <= end;
    case ts.SyntaxKind.GreaterThanEqualsToken: return start < end;
    default: return false;
  }
}

function* capacityCounters(facts: AdmissionFacts | undefined, binding: ts.Symbol | undefined,
  budget: AnalysisBudget): Iterable<ts.Symbol> {
  for (let scope = facts; scope; scope = scope.enclosing) {
    budget.take();
    const marks = binding ? scope.capacityGuards?.get(binding) : scope.capacityChecks;
    for (const candidate of marks?.keys() ?? []) { budget.take(); yield candidate; }
  }
}

function capacityCheckedAt(facts: AdmissionFacts | undefined, binding: ts.Symbol | undefined,
  counter: ts.Symbol, budget: AnalysisBudget): number | undefined {
  for (let scope = facts; scope; scope = scope.enclosing) {
    budget.take();
    const marks = binding ? scope.capacityGuards?.get(binding) : scope.capacityChecks;
    const positions = marks?.get(counter);
    const checkedAt = positions && scope.before !== undefined ? lastBefore(positions, scope.before, budget) : undefined;
    if (checkedAt !== undefined) return checkedAt;
  }
  return undefined;
}

function admissionAt(facts: AdmissionFacts, end: number, budget: AnalysisBudget): AdmissionFacts {
  const lastSuspension = lastBefore(facts.awaitEnds, end, budget);
  return lastSuspension === undefined || lastSuspension <= (facts.awaitStart ?? -1) || lastSuspension <= facts.lastSuspension ? facts : { ...facts, state: "resumed", lastSuspension, capacitySegment: undefined };
}

function refreshedState(facts: AdmissionFacts, counter: ts.Symbol | undefined, budget: AnalysisBudget): AdmissionState {
  if (facts.state !== "resumed" || !counter || facts.before === undefined) return facts.state;
  const checkedAt = capacityCheckedAt(facts, undefined, counter, budget);
  return checkedAt !== undefined && checkedAt > facts.lastSuspension ? "guarded" : "resumed";
}

interface KnownQueueCounters { symbols: ReadonlySet<ts.Symbol> }

interface CapacityCache {
  unit: WeakMap<object, ReadonlySet<ts.Symbol> | null>;
  batch: WeakMap<object, ReadonlySet<ts.Symbol> | null>;
}

/** Both direct enqueues and helper edges consume the same admission segment.
 * Scalar guards remain separate from batch admission, even at the same site. */
function cachedCapacityChecks(facts: AdmissionFacts, counters: KnownQueueCounters, caches: CapacityCache,
  budget: AnalysisBudget, includeScalar = true): ReadonlySet<ts.Symbol> | undefined {
  const key = facts.capacitySegment ?? facts;
  const cache = includeScalar ? caches.unit : caches.batch;
  let capacity = cache.get(key);
  if (capacity === undefined) {
    capacity = knownCapacityChecks(facts, counters, budget, includeScalar) ?? null;
    cache.set(key, capacity);
  }
  return capacity ?? undefined;
}

function capacityMentioned(facts: AdmissionFacts, counters: ReadonlySet<ts.Symbol>, includePlain: boolean, budget: AnalysisBudget): boolean {
  for (let scope: AdmissionFacts | undefined = facts; scope; scope = scope.enclosing) {
    budget.take();
    const before = scope.before;
    if (before === undefined) continue;
    for (const [candidate, positions] of scope.uncertainCapacity ?? []) {
      budget.take();
      if (counters.has(candidate) && lastBefore(positions, before, budget) !== undefined) return true;
    }
    if (!includePlain) continue;
    for (const [candidate, positions] of scope.capacityMentions ?? []) {
      budget.take();
      if (counters.has(candidate) && lastBefore(positions, before, budget) !== undefined) return true;
    }
  }
  return false;
}

function knownCapacityChecks(facts: AdmissionFacts, counters: KnownQueueCounters, budget: AnalysisBudget,
  includeScalar = true): ReadonlySet<ts.Symbol> | undefined {
  const { symbols } = counters;
  if (facts.state !== "guarded" && !(facts.state === "resumed" && includeScalar)) return undefined;
  let checked: Set<ts.Symbol> | undefined;
  for (let scope: AdmissionFacts | undefined = facts; scope; scope = scope.enclosing) {
    budget.take();
    const before = scope.before;
    if (before === undefined) continue;
    const collect = (candidate: ts.Symbol, positions: number[]): void => {
      budget.take();
      if (!symbols.has(candidate) || checked?.has(candidate)) return;
      const position = lastBefore(positions, before, budget);
      if (position !== undefined && position > facts.lastSuspension) (checked ??= new Set()).add(candidate);
    };
    for (const [candidate, positions] of scope.capacityChecks ?? []) collect(candidate, positions);
    if (includeScalar) for (const [candidate, positions] of scope.scalarCapacity ?? []) collect(candidate, positions);
  }
  if (checked) return checked;
  if (facts.state === "resumed") return undefined;
  // An escaping branch is not itself capacity evidence. Authentication,
  // routing and validation exits leave the queue open unless a bound for its
  // own counter was established on every path to this admission segment.
  return new Set();
}

function counterAdmissionState(facts: AdmissionFacts, counter: ts.Symbol | undefined,
  invalid: ts.Symbol | undefined, capacity: ReadonlySet<ts.Symbol> | undefined, budget: AnalysisBudget, depth?: ts.Symbol): AdmissionState {
  if (capacity && depth && capacity.has(depth)) return "guarded";
  if (capacity && (!counter || !capacity.has(counter))) return "open";
  if (capacity && counter && facts.state === "resumed") return "guarded";
  if (facts.state === "guarded" && invalid && capacityCheckedAt(facts, undefined, invalid, budget) !== undefined) return "open";
  return refreshedState(facts, counter, budget);
}

function lastBefore(positions: number[], end: number, budget: AnalysisBudget): number | undefined {
  let low = 0;
  let high = positions.length;
  while (low < high) {
    budget.take();
    const middle = (low + high) >>> 1;
    if (positions[middle] >= end) high = middle;
    else low = middle + 1;
  }
  return positions[low - 1];
}

/** Resolved incoming calls can show admission before entering an enqueue helper. */
type QueueCaller = readonly [ts.CallExpression | ts.NewExpression | null, boolean | "deferred" | ts.Expression];

function reusableQueueCallers(requests: RequestReachability, admission: AdmissionIndex, budget: AnalysisBudget):
  (fn: ts.SignatureDeclaration) => readonly QueueCaller[] {
  const cache = new WeakMap<ts.SignatureDeclaration, QueueCaller[]>();
  return fn => {
    const known = cache.get(fn);
    if (known) return known;
    const callers: QueueCaller[] = [];
    const segments = new Set<object>();
    for (const [site, batch] of requests.queueCallers(fn) ?? []) {
      budget.take();
      // A direct call in an unchanged admission segment has the same owner,
      // guard and suspension facts. Batch edges still need their own payload.
      const segment = site && batch === false ? callAdmission(site, admission, budget)?.capacitySegment : undefined;
      if (segment) {
        if (segments.has(segment)) continue;
        segments.add(segment);
      }
      callers.push([site, batch]);
      if (site === null || batch === "deferred") break;
    }
    cache.set(fn, callers);
    return callers;
  };
}

function guardedProducerCalls(
  queues: Queue[], requests: RequestReachability,
  admission: AdmissionIndex, counters: QueueCounters, knownQueueCounters: KnownQueueCounters,
  budget: AnalysisBudget,
) {
  const ownerCache = new WeakMap<ts.Node, ts.SignatureDeclaration | null>();
  const clampCache = new WeakMap<ts.Expression, BatchClamp | null>();
  const capacityCache = admission.capacityCache;
  const callersFor = reusableQueueCallers(requests, admission, budget);
  const blocked = new Set<ts.CallExpression>();
  const nativeMath = requests.nativeMathUnchanged();
  const relevantCounters = new Set<ts.Symbol>();
  // An open path with no capacity-dependent edge settles every counter group.
  const independent = new Set<ts.CallExpression>();
  guardQueueProducers(queues, requests, admission, undefined, undefined, nativeMath, ownerCache, clampCache,
    capacityCache, callersFor, knownQueueCounters, blocked, independent, budget, relevantCounters);
  const groups = new Map<ts.Symbol, Queue[]>();
  for (const queue of queues) {
    budget.take();
    const counter = counters.valid.get(queue) ?? counters.invalid.get(queue);
    const groupKey = queue.depth && relevantCounters.has(queue.depth) ? queue.depth
      : counter && (counters.invalid.has(queue) || relevantCounters.has(counter)) ? counter : undefined;
    if (!groupKey) continue;
    if (!queue.producers.some(call => { budget.take(); return requests.evidence(call) === "request" && !independent.has(call); })) continue;
    const group = groups.get(groupKey);
    if (group) group.push(queue);
    else groups.set(groupKey, [queue]);
  }
  for (const [groupKey, group] of groups) {
    budget.take();
    for (const queue of group) for (const call of queue.producers) { budget.take(); blocked.delete(call); }
    guardQueueProducers(group, requests, admission, counters.valid.get(group[0]), counters.invalid.get(group[0]),
      nativeMath, ownerCache, clampCache, capacityCache, callersFor, knownQueueCounters, blocked, independent, budget,
      undefined, groupKey === group[0].depth ? groupKey : undefined);
  }
  const reservationChecks = new WeakMap<Queue, Set<ts.CallExpression>>();
  const reserved = (queue: Queue, counter: ts.Symbol, call: ts.CallExpression): boolean => {
    if (!relevantCounters.has(counter)) return false;
    // Without a depth guard the ordinary pass already checked this exact counter.
    if (!queue.depth || !relevantCounters.has(queue.depth)) return blocked.has(call);
    let checked = reservationChecks.get(queue);
    if (!checked) {
      checked = new Set();
      guardQueueProducers([queue], requests, admission, counter, undefined, nativeMath, ownerCache, clampCache,
        capacityCache, callersFor, knownQueueCounters, checked, independent, budget);
      reservationChecks.set(queue, checked);
    }
    return checked.has(call);
  };
  return { producers: blocked, reserved };
}

function guardQueueProducers(queues: Queue[], requests: RequestReachability,
  admission: AdmissionIndex, counter: ts.Symbol | undefined, invalid: ts.Symbol | undefined, nativeMath: boolean,
  ownerCache: WeakMap<ts.Node, ts.SignatureDeclaration | null>, clampCache: WeakMap<ts.Expression, BatchClamp | null>,
  capacityCache: CapacityCache,
  callersFor: (fn: ts.SignatureDeclaration) => readonly QueueCaller[], knownQueueCounters: KnownQueueCounters,
  blocked: Set<ts.CallExpression>, independent: Set<ts.CallExpression>, budget: AnalysisBudget,
  relevantCounters?: Set<ts.Symbol>, depth?: ts.Symbol): void {
  const owners = new Map<ts.CallExpression, ts.SignatureDeclaration>();
  const pending: ts.SignatureDeclaration[] = [];
  const visited = new Set<ts.SignatureDeclaration>();
  const dependents = new Map<ts.SignatureDeclaration, ts.SignatureDeclaration[]>();
  const capacityDependents = new Map<ts.SignatureDeclaration, ts.SignatureDeclaration[]>();
  const unguarded = new Set<ts.SignatureDeclaration>();
  const open: ts.SignatureDeclaration[] = [];
  const independentOwners = new Set<ts.SignatureDeclaration>();
  const independentOpen: ts.SignatureDeclaration[] = [];
  const markUnguarded = (fn: ts.SignatureDeclaration): void => {
    if (unguarded.has(fn)) return;
    unguarded.add(fn);
    open.push(fn);
  };
  const markIndependent = (fn: ts.SignatureDeclaration): void => {
    markUnguarded(fn);
    if (!relevantCounters || independentOwners.has(fn)) return;
    independentOwners.add(fn);
    independentOpen.push(fn);
  };
  for (const queue of queues) for (const call of queue.producers) {
    budget.take();
    if (requests.evidence(call) !== "request" || independent.has(call)) continue;
    const fn = callOwner(call, ownerCache, budget);
    if (!fn) continue;
    owners.set(call, fn);
    pending.push(fn);
  }
  // A bounded native callback inherits the caller's admission just like a
  // direct helper. An unknown-size batch can bypass every guard above it.
  while (pending.length) {
    budget.take();
    const fn = pending.pop()!;
    if (visited.has(fn)) continue;
    visited.add(fn);
    const callers = callersFor(fn);
    if (!callers.length) markIndependent(fn);
    for (const [caller, batch] of callers) {
      budget.take();
      if (caller === null) {
        markIndependent(fn);
        break;
      }
      const facts = callAdmission(caller, admission, budget);
      if (facts?.unreachable) continue;
      if (batch === "deferred") {
        markIndependent(fn);
        break;
      }
      const capacity = facts && cachedCapacityChecks(facts, knownQueueCounters, capacityCache, budget, batch === false);
      if (relevantCounters && capacity) {
        for (const candidate of capacity) { budget.take(); relevantCounters.add(candidate); }
      }
      const state = facts && counterAdmissionState(facts, counter, invalid, capacity, budget, depth);
      const clamp = nativeMath && typeof batch === "object" ? batchClamp(batch, clampCache, budget) : undefined;
      if (relevantCounters && clamp) for (const candidate of clamp.remaining) { budget.take(); relevantCounters.add(candidate); }
      if (clamp && (counter && clamp.remaining.has(counter) || depth && clamp.remaining.has(depth)) && facts && clamp.call.end > facts.lastSuspension
        && clamp.call.end <= caller.end && callOwner(clamp.call, ownerCache, budget) === callOwner(caller, ownerCache, budget)) continue;
      if (batch && !clamp?.fixed) {
        const binding = typeof batch === "object" && immutableBinding(batch, budget);
        if (relevantCounters && binding) for (const candidate of capacityCounters(facts, binding, budget)) {
          budget.take(); relevantCounters.add(candidate);
        }
        const guardedAt = binding ? Math.max(counter && capacityCheckedAt(facts, binding, counter, budget) || -1,
          depth && capacityCheckedAt(facts, binding, depth, budget) || -1) : undefined;
        if (facts && guardedAt && guardedAt > facts.lastSuspension) continue;
        markUnguarded(fn);
        if (relevantCounters) continue;
        break;
      }
      if (state === "resumed") {
        if (relevantCounters) for (const candidate of capacityCounters(facts, undefined, budget)) { budget.take(); relevantCounters.add(candidate); }
        markUnguarded(fn);
        if (relevantCounters) continue;
        break;
      }
      if (!state || state === "guarded") continue;
      const parent = callOwner(caller, ownerCache, budget);
      if (!parent) {
        if (capacity) markUnguarded(fn);
        else markIndependent(fn);
        break;
      }
      // This edge is open for an unrelated counter, but can close for its own
      // queue during the specialized pass. Do not propagate independent proof.
      const edges = capacity ? capacityDependents : dependents;
      const children = edges.get(parent);
      if (children) children.push(fn);
      else edges.set(parent, [fn]);
      pending.push(parent);
    }
  }
  while (open.length) {
    budget.take();
    const fn = open.pop()!;
    for (const child of dependents.get(fn) ?? []) { budget.take(); markUnguarded(child); }
    for (const child of capacityDependents.get(fn) ?? []) { budget.take(); markUnguarded(child); }
  }
  // Propagate the stronger proof separately from default-state reachability.
  while (independentOpen.length) {
    budget.take();
    const fn = independentOpen.pop()!;
    for (const child of dependents.get(fn) ?? []) { budget.take(); markIndependent(child); }
  }
  for (const [call, fn] of owners) {
    budget.take();
    if (independentOwners.has(fn)) independent.add(call);
    if (!unguarded.has(fn)) blocked.add(call);
  }
}

function globalObject(expr: ts.Expression): boolean {
  return ts.isIdentifier(expr) && /^(global|globalThis)$/.test(expr.text) && !symbolOf(expr)?.declarations?.length;
}

function namedAccess(node: ts.Node, name: string): ts.Expression | undefined {
  if (ts.isPropertyAccessExpression(node) && node.name.text === name) return node.expression;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
    && node.argumentExpression.text === name) return node.expression;
  return undefined;
}

// In JavaScript the checker can synthesize a symbol from a global write.
// A lexical declaration shadows the host timer API, a synthetic one does not.
function hostIdentifier(identifier: ts.Identifier): boolean {
  const symbol = ts.isShorthandPropertyAssignment(identifier.parent)
    ? checkerFor(identifier.getSourceFile()).getShorthandAssignmentValueSymbol(identifier.parent) : symbolOf(identifier);
  return !symbol?.declarations?.length || !!(symbol.flags & ts.SymbolFlags.Assignment);
}

function cancellationMethod(node: ts.Expression, globalAliases: WeakMap<ts.Symbol, boolean>, budget: AnalysisBudget): string | undefined {
  for (const name of ["clearInterval", "clearTimeout"]) {
    if (ts.isIdentifier(node) && node.text === name && hostIdentifier(node)) return name;
    const receiver = namedAccess(node, name);
    if (receiver && aliasesHostGlobal(receiver, globalAliases, budget, true)) return name;
  }
  return undefined;
}

const hostMemberKeys = new WeakMap<AnalysisBudget, WeakMap<ts.Symbol, ts.Expression>>();

/** Follow immutable local names and native self aliases when looking for writes through a host object. */
function aliasesHostGlobal(expression: ts.Expression, memo: WeakMap<ts.Symbol, boolean>, budget: AnalysisBudget,
  initialized = false): boolean {
  const path = new Set<ts.Symbol>();
  let result = false;
  for (;;) {
    budget.take();
    expression = unwrap(expression, budget);
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      let aliases = hostMemberKeys.get(budget);
      if (!aliases) { aliases = new WeakMap(); hostMemberKeys.set(budget, aliases); }
      const key = ts.isPropertyAccessExpression(expression) ? expression.name.text
        : patchPropertyKey(expression.argumentExpression, aliases, budget);
      if (key !== "globalThis" && key !== "global") break;
      expression = expression.expression;
      continue;
    }
    if (!ts.isIdentifier(expression)) break;
    if (/^(global|globalThis)$/.test(expression.text) && hostIdentifier(expression)) {
      result = true;
      break;
    }
    const symbol = symbolOf(expression);
    if (!symbol || path.has(symbol)) break;
    const declaration = symbol.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer
      || !(declaration.parent.flags & ts.NodeFlags.Const) || initialized && declaration.end > expression.pos) break;
    const known = memo.get(symbol);
    if (known !== undefined) {
      result = known;
      break;
    }
    path.add(symbol);
    expression = declaration.initializer;
  }
  for (const symbol of path) { budget.take(); memo.set(symbol, result); }
  return result;
}

const TRACKED_HOST_METHODS = ["setInterval", "clearInterval", "clearTimeout", "Boolean"];
type TimerWrites = Map<string, { source: ts.SourceFile; position: number } | null>;

/** Keep a comparable earliest write only when every known write is ordered
 * within the same startup unit. Other writes may precede any local use. */
function recordTimerWrite(method: string, operation: ts.Node, writes: TimerWrites, orderedBlocks: WeakMap<ts.Block, boolean>,
  budget: AnalysisBudget): void {
  const previous = writes.get(method);
  if (previous === null) return;
  const source = operation.getSourceFile();
  const position = orderedWritePosition(operation, orderedBlocks, budget);
  if (position < 0 || previous && previous.source !== source) writes.set(method, null);
  else if (!previous || position < previous.position) writes.set(method, { source, position });
}

function initializedAlias(expression: ts.Expression, memo: WeakMap<ts.Symbol, ts.Expression>, budget: AnalysisBudget): ts.Expression {
  const path: ts.Symbol[] = [];
  expression = unwrap(expression, budget);
  while (ts.isIdentifier(expression)) {
    budget.take();
    const symbol = symbolOf(expression);
    const declaration = symbol?.valueDeclaration;
    if (!symbol || !declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer
      || !(declaration.parent.flags & ts.NodeFlags.Const) || declaration.end > expression.pos) break;
    const known = memo.get(symbol);
    if (known) { expression = known; break; }
    path.push(symbol);
    expression = unwrap(declaration.initializer, budget);
  }
  for (const symbol of path) { budget.take(); memo.set(symbol, expression); }
  return expression;
}

/** Track writes through native property mutators without discarding a valid
 * drain when only its cancellation API has changed. */
/** A source object's keys can be reused only while its aliases never escape or
 * receive writes. Other uses retain the existing unknown-mutation fallback. */
function unsafeHostPatchAliases(workspace: Workspace, aliases: WeakMap<ts.Symbol, ts.Expression>,
  budget: AnalysisBudget): WeakSet<ts.ObjectLiteralExpression> {
  const unsafe = new WeakSet<ts.ObjectLiteralExpression>();
  const sourceArguments = new WeakMap<ts.CallExpression, ReadonlySet<ts.Expression>>();
  const copyingArgument = (call: ts.CallExpression, argument: ts.Node): boolean => {
    budget.take();
    let sources = sourceArguments.get(call);
    if (!sources) {
      const known = new Set<ts.Expression>();
      const native = nativeTimerObjectMethod(call.expression, aliases, budget);
      if (native?.owner === "Object" && (native.key === "assign" || native.key === "defineProperties")) {
        // Index a wide source list once instead of searching it for every use.
        for (let index = 1; index < call.arguments.length; index++) {
          budget.take();
          known.add(call.arguments[index]);
          if (native.key === "defineProperties") break;
        }
      }
      sources = known;
      sourceArguments.set(call, sources);
    }
    return sources.has(argument as ts.Expression);
  };
  for (const { sf } of workspace.units) {
    const pending: ts.Node[] = [sf];
    while (pending.length) {
      budget.take();
      const node = pending.pop()!;
      if (ts.isIdentifier(node)) {
        const object = initializedAlias(node, aliases, budget);
        if (ts.isObjectLiteralExpression(object) && !unsafe.has(object)) {
          let use: ts.Node = node;
          while (unwrapParent(use.parent)) { budget.take(); use = use.parent; }
          const parent = use.parent;
          const alias = ts.isVariableDeclaration(parent) && parent.initializer === use
            && ts.isVariableDeclarationList(parent.parent) && !!(parent.parent.flags & ts.NodeFlags.Const);
          const copying = ts.isCallExpression(parent) && copyingArgument(parent, use);
          if (!alias && !copying) unsafe.add(object);
        }
      }
      ts.forEachChild(node, child => { pending.push(child); });
    }
  }
  return unsafe;
}

function markTimerMutator(call: ts.CallExpression, replaced: TimerWrites,
  globalAliases: WeakMap<ts.Symbol, boolean>, timerAliases: WeakMap<ts.Symbol, ts.Expression>,
  unsafePatches: WeakSet<ts.ObjectLiteralExpression>,
  shapes: WeakMap<ts.ObjectLiteralExpression, ReadonlySet<string> | null>,
  orderedBlocks: WeakMap<ts.Block, boolean>, budget: AnalysisBudget): void {
  if (!call.arguments.length) return;
  const callee = unwrap(call.expression, budget);
  if ((ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
    && aliasesHostGlobal(callee.expression, globalAliases, budget)) {
    const method = patchMemberKey(callee, timerAliases, budget);
    if (method === "__defineGetter__" || method === "__defineSetter__") {
      const key = patchPropertyKey(call.arguments[0], timerAliases, budget);
      for (const name of TRACKED_HOST_METHODS) {
        budget.take();
        if (key === undefined || key === name) recordTimerWrite(name, call, replaced, orderedBlocks, budget);
      }
      return;
    }
  }
  const native = nativeTimerObjectMethod(call.expression, timerAliases, budget);
  if (!native) return;
  const { owner, key: method } = native;
  const methods = owner === "Object" ? /^(assign|defineProperty|defineProperties|setPrototypeOf)$/
    : /^(defineProperty|set|deleteProperty|setPrototypeOf)$/;
  if (!methods.test(method) || !aliasesHostGlobal(call.arguments[0], globalAliases, budget)) return;
  const mark = (key: string): void => {
    if (TRACKED_HOST_METHODS.includes(key)) recordTimerWrite(key, call, replaced, orderedBlocks, budget);
  };
  const markUnknown = (): void => { for (const method of TRACKED_HOST_METHODS) mark(method); };
  if (method === "setPrototypeOf") {
    markUnknown();
    return;
  }
  if (method !== "assign" && method !== "defineProperties") {
    const key = call.arguments[1] && initializedAlias(call.arguments[1], timerAliases, budget);
    if (key && ts.isStringLiteralLike(key)) mark(key.text);
    else markUnknown();
    return;
  }
  for (let index = 1; index < call.arguments.length; index++) {
    budget.take();
    const source = initializedAlias(call.arguments[index], timerAliases, budget);
    if (!ts.isObjectLiteralExpression(source) || unsafePatches.has(source)) { markUnknown(); return; }
    let keys = shapes.get(source);
    if (keys === undefined) {
      const known = new Set<string>();
      keys = known;
      for (const property of source.properties) {
        budget.take();
        if (ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) { keys = null; break; }
        const name = property.name;
        const computed = name && ts.isComputedPropertyName(name)
          ? initializedAlias(name.expression, timerAliases, budget) : undefined;
        const key = name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text
          : computed && ts.isStringLiteralLike(computed) ? computed.text : undefined;
        if (key === undefined) { keys = null; break; }
        if (TRACKED_HOST_METHODS.includes(key)) known.add(key);
      }
      shapes.set(source, keys);
    }
    if (keys === null) { markUnknown(); return; }
    // Only the small tracked-key set is replayed for later copies of a shape.
    for (const key of keys) { budget.take(); mark(key); }
    if (method === "defineProperties") return;
  }
}

function writeTarget(node: ts.Node): ts.Expression | undefined {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
    && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return node.left;
  if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
    && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) return node.operand;
  if (ts.isDeleteExpression(node)) return node.expression;
  if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) return node.initializer;
  return undefined;
}

function intervalPrototype(expression: ts.Expression, aliases: WeakMap<ts.Symbol, ts.Expression>,
  prototypes: WeakMap<ts.Expression, boolean>, summaries: WeakMap<ts.Declaration, HelperRegistration | null>,
  budget: AnalysisBudget): boolean {
  const value = initializedAlias(expression, aliases, budget);
  const known = prototypes.get(value);
  if (known !== undefined) return known;
  const constructorAccess = namedAccess(value, "prototype");
  let timer = constructorAccess && namedAccess(constructorAccess, "constructor");
  if (!timer && ts.isCallExpression(value) && value.arguments.length === 1 && !value.questionDotToken) {
    const method = nativeTimerObjectMethod(value.expression, aliases, budget);
    if (method?.key === "getPrototypeOf") timer = value.arguments[0];
  }
  const registration = timer && initializedAlias(timer, aliases, budget);
  let result = false;
  if (registration && ts.isCallExpression(registration)) {
    result = ts.isIdentifier(registration.expression) && registration.expression.text === "setInterval" && !symbolOf(registration.expression)
      || !!startupInterval(registration, summaries, budget)?.result;
  }
  prototypes.set(value, result);
  return result;
}

function unrefWrite(node: ts.Node, aliases: WeakMap<ts.Symbol, ts.Expression>,
  prototypes: WeakMap<ts.Expression, boolean>, summaries: WeakMap<ts.Declaration, HelperRegistration | null>,
  budget: AnalysisBudget): boolean {
  const target = writeTarget(node);
  const member = target && unwrap(target, budget);
  return !!member && (ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member))
    && mayWriteUnref(member, aliases, budget) && intervalPrototype(member.expression, aliases, prototypes, summaries, budget);
}

function mayWriteUnref(member: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  aliases: WeakMap<ts.Symbol, ts.Expression>, budget: AnalysisBudget): boolean {
  if (ts.isPropertyAccessExpression(member)) return member.name.text === "unref";
  return mayNameUnref(initializedAlias(member.argumentExpression, aliases, budget));
}

function mayNameUnref(key: ts.Node): boolean {
  return ts.isStringLiteralLike(key) ? key.text === "unref" : !ts.isNumericLiteral(key);
}

function primitivePatch(expression: ts.Expression): boolean {
  return ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression) || ts.isBigIntLiteral(expression)
    || expression.kind === ts.SyntaxKind.NullKeyword || expression.kind === ts.SyntaxKind.TrueKeyword
    || expression.kind === ts.SyntaxKind.FalseKeyword;
}

interface PatchWrite {
  operation: ts.Node;
  position: number;
  source?: ts.Expression;
  hidesUnref?: boolean;
}

interface PatchWrites {
  mutations: WeakMap<ts.ObjectLiteralExpression, PatchWrite[]>;
  hiddenThrough: WeakMap<ts.ObjectLiteralExpression, number[]>;
  unordered: WeakSet<ts.ObjectLiteralExpression>;
  orderedBlocks: WeakMap<ts.Block, boolean>;
}

interface PatchShape {
  safeThrough: number;
  unsafeFrom: number;
}

type PatchShapes = WeakMap<ts.ObjectLiteralExpression, Map<number, PatchShape>>;

function nativeTimerObjectMethod(expression: ts.Expression, aliases: WeakMap<ts.Symbol, ts.Expression>,
  budget: AnalysisBudget): { owner: string; key: string } | undefined {
  const callee = initializedAlias(expression, aliases, budget);
  if ((!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) || callee.questionDotToken) return undefined;
  const receiver = initializedAlias(callee.expression, aliases, budget);
  if (!ts.isIdentifier(receiver) || (receiver.text !== "Object" && receiver.text !== "Reflect") || !hostIdentifier(receiver)) return undefined;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name : initializedAlias(callee.argumentExpression, aliases, budget);
  if (ts.isIdentifier(name) && ts.isPropertyAccessExpression(callee) || ts.isStringLiteralLike(name)) {
    return { owner: receiver.text, key: name.text };
  }
  return undefined;
}

function unrefMutatorKind(call: ts.CallExpression, aliases: WeakMap<ts.Symbol, ts.Expression>,
  budget: AnalysisBudget): "copy" | "descriptorMap" | "property" | undefined {
  if (call.arguments.length < 2) return undefined;
  const target = nativeTimerObjectMethod(call.expression, aliases, budget);
  if (!target) return undefined;
  const { owner, key: method } = target;
  if (owner === "Object" && method === "assign") return "copy";
  if (owner === "Object" && method === "defineProperties") return "descriptorMap";
  if (owner === "Object" && method === "defineProperty" || owner === "Reflect" && /^(set|defineProperty|deleteProperty)$/.test(method)) return "property";
  return undefined;
}

function patchPropertyKey(expression: ts.Expression, aliases: WeakMap<ts.Symbol, ts.Expression>, budget: AnalysisBudget): string | undefined {
  const key = initializedAlias(expression, aliases, budget);
  return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : undefined;
}

function patchMemberKey(member: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  aliases: WeakMap<ts.Symbol, ts.Expression>, budget: AnalysisBudget): string | undefined {
  return ts.isPropertyAccessExpression(member) ? member.name.text : patchPropertyKey(member.argumentExpression, aliases, budget);
}

/** A known set of native write keys can preserve unrelated descriptor facts. */
function patchMutationKeys(call: ts.CallExpression, kind: "copy" | "descriptorMap" | "property",
  aliases: WeakMap<ts.Symbol, ts.Expression>, cache: WeakMap<ts.ObjectLiteralExpression, ReadonlySet<string> | null>,
  budget: AnalysisBudget): ReadonlySet<string | undefined> {
  if (kind === "property") return new Set([patchPropertyKey(call.arguments[1], aliases, budget)]);
  const keys = new Set<string | undefined>();
  for (let index = 1; index < call.arguments.length; index++) {
    budget.take();
    // Only direct object literals have a known shape at the call site.
    const source = unwrap(call.arguments[index], budget);
    if (!ts.isObjectLiteralExpression(source)) return new Set([undefined]);
    let names = cache.get(source);
    if (names === undefined) {
      const known = new Set<string>();
      names = known;
      for (const property of source.properties) {
        budget.take();
        const name = property.name;
        const key = name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text
          : ts.isComputedPropertyName(name) ? patchPropertyKey(name.expression, aliases, budget) : undefined);
        if (key === undefined) { names = null; break; }
        known.add(key);
      }
      cache.set(source, names);
    }
    if (!names) return new Set([undefined]);
    for (const key of names) { budget.take(); keys.add(key); }
    if (kind === "descriptorMap") break;
  }
  return keys;
}

type DescriptorFunction = PlainFunction | ts.MethodDeclaration;
type DescriptorKey = string | number;

function descriptorFunction(expression: ts.Expression, call: ts.CallExpression,
  aliases: WeakMap<ts.Symbol, ts.Expression>, budget: AnalysisBudget): DescriptorFunction | undefined {
  const value = unwrap(expression, budget);
  if (!ts.isPropertyAccessExpression(value) && !ts.isElementAccessExpression(value)) return plainFunction(value, call, budget);
  const receiver = initializedAlias(value.expression, aliases, budget);
  const key = patchMemberKey(value, aliases, budget);
  if (!ts.isObjectLiteralExpression(receiver) || key === undefined) return undefined;
  const declaration = checkerFor(receiver.getSourceFile()).getTypeAtLocation(receiver).getProperty(key)?.valueDeclaration;
  if (!declaration || declaration.parent !== receiver) return undefined;
  if (ts.isPropertyAssignment(declaration)) return plainFunction(declaration.initializer, call, budget);
  if (ts.isMethodDeclaration(declaration) && declaration.body && !declaration.asteriskToken
    && !ts.getModifiers(declaration)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return declaration;
  return undefined;
}

function descriptorInvocation(call: ts.CallExpression, aliases: WeakMap<ts.Symbol, ts.Expression>,
  budget: AnalysisBudget): { fn: DescriptorFunction; args: readonly ts.Expression[] } | undefined {
  const callee = unwrap(call.expression, budget);
  if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
    const key = patchMemberKey(callee, aliases, budget);
    if (key === "call" || key === "apply") {
      const fn = descriptorFunction(callee.expression, call, aliases, budget);
      if (fn && key === "call") {
        budget.take(call.arguments.length);
        if (!call.arguments.some(ts.isSpreadElement)) return { fn, args: call.arguments.slice(1) };
      } else if (fn && call.arguments.length >= 2) {
        // An aliased array can have been mutated before this invocation.
        const args = unwrap(call.arguments[1], budget);
        if (ts.isArrayLiteralExpression(args)) {
          budget.take(args.elements.length);
          if (!args.elements.some(element => ts.isSpreadElement(element) || ts.isOmittedExpression(element))) {
            return { fn, args: args.elements };
          }
        }
      }
    }
  }
  const fn = descriptorFunction(callee, call, aliases, budget);
  return fn && { fn, args: call.arguments };
}

interface DescriptorPath {
  index: number;
  members: readonly DescriptorKey[];
}

interface DescriptorWrite {
  members: readonly DescriptorKey[];
  key: DescriptorKey | undefined;
  dynamic: boolean;
}

type DescriptorWrites = Map<number, DescriptorWrite[]>;

/** Only use visible parameter writes. The summary records which properties can
 * change, independently of the concrete objects passed by each call. */
function descriptorParameterWrites(fn: DescriptorFunction, aliases: WeakMap<ts.Symbol, ts.Expression>,
  nativeKeys: WeakMap<ts.ObjectLiteralExpression, ReadonlySet<string> | null>, budget: AnalysisBudget,
  summaries: WeakMap<DescriptorFunction, DescriptorWrites>): DescriptorWrites {
  type Parameters = Map<ts.Symbol, { path?: DescriptorPath; key?: DescriptorKey }>;
  type Frame = {
    fn: DescriptorFunction; parameters: Parameters; writes: DescriptorWrites; keys: Map<number, Set<string>>;
    pending: ts.Node[]; visited: WeakSet<ts.Expression>;
    waiting?: { fn: DescriptorFunction; args: readonly ts.Expression[] };
  };
  const active = new Set<DescriptorFunction>();
  function keyFor(expression: ts.Expression, parameters: Parameters): DescriptorKey | undefined {
    const value = initializedAlias(expression, aliases, budget);
    return ts.isIdentifier(value) ? parameters.get(symbolOf(value)!)?.key : patchPropertyKey(value, aliases, budget);
  }
  function memberKey(member: ts.PropertyAccessExpression | ts.ElementAccessExpression, parameters: Parameters): DescriptorKey | undefined {
    return ts.isPropertyAccessExpression(member) ? member.name.text : keyFor(member.argumentExpression, parameters);
  }
  function pathFor(expression: ts.Expression, parameters: Parameters): DescriptorPath | undefined {
    let value = initializedAlias(expression, aliases, budget);
    const reversed: DescriptorKey[] = [];
    while (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      budget.take();
      const key = memberKey(value, parameters);
      if (key === undefined) return undefined;
      reversed.push(key);
      value = initializedAlias(value.expression, aliases, budget);
    }
    const symbol = ts.isIdentifier(value) && symbolOf(value);
    const path = symbol && parameters.get(symbol)?.path;
    if (!path) return undefined;
    if (!reversed.length) return path;
    budget.take(path.members.length + reversed.length);
    return { index: path.index, members: [...path.members, ...reversed.reverse()] };
  }
  function mark(frame: Frame, path: DescriptorPath, key: DescriptorKey | undefined): void {
    budget.take(path.members.length + 1);
    const identity = JSON.stringify([path.members, key]);
    let keys = frame.keys.get(path.index);
    if (!keys) { keys = new Set(); frame.keys.set(path.index, keys); }
    if (keys.has(identity)) return;
    keys.add(identity);
    const entries = frame.writes.get(path.index) ?? [];
    entries.push({ members: path.members, key, dynamic: typeof key === "number" || path.members.some(member => typeof member === "number") });
    frame.writes.set(path.index, entries);
  }
  function parametersFor(target: DescriptorFunction): Parameters {
    const parameters: Parameters = new Map();
    for (let index = 0; index < target.parameters.length; index++) {
      budget.take();
      const parameter = target.parameters[index];
      if (parameter.dotDotDotToken) continue;
      const pending: Array<{ name: ts.BindingName; path: DescriptorPath; key?: DescriptorKey }> = [
        { name: parameter.name, path: { index, members: [] }, key: index },
      ];
      while (pending.length) {
        budget.take();
        const binding = pending.pop()!;
        if (ts.isIdentifier(binding.name)) {
          const symbol = symbolOf(binding.name);
          if (symbol) parameters.set(symbol, binding);
        } else {
          for (let i = 0; i < binding.name.elements.length; i++) {
            budget.take();
            const element = binding.name.elements[i];
            if (ts.isOmittedExpression(element) || element.dotDotDotToken) continue;
            const name = element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined);
            const member = ts.isArrayBindingPattern(binding.name) ? String(i)
              : name && (ts.isComputedPropertyName(name) ? keyFor(name.expression, parameters) : name.text);
            if (member === undefined) continue;
            budget.take(binding.path.members.length);
            pending.push({ name: element.name, path: { index: binding.path.index, members: [...binding.path.members, member] } });
          }
        }
      }
    }
    return parameters;
  }
  // Summaries use the callee's parameter indexes. Compose each finished child
  // into its caller once; shared helper graphs must not replay every path.
  function apply(frame: Frame, writes: DescriptorWrites, args: readonly ts.Expression[]): void {
    const key = (value: DescriptorKey | undefined): DescriptorKey | undefined =>
      typeof value === "number" ? args[value] && keyFor(args[value], frame.parameters) : value;
    for (const [index, entries] of writes) {
      budget.take();
      const argument = args[index], path = argument && pathFor(argument, frame.parameters);
      if (!path) continue;
      for (const entry of entries) {
        budget.take(path.members.length + 1);
        const members = [...path.members];
        let known = true;
        for (const member of entry.members) {
          budget.take();
          const resolved = key(member);
          if (resolved === undefined) { known = false; break; }
          members.push(resolved);
        }
        if (known) mark(frame, { index: path.index, members }, key(entry.key));
      }
    }
  }
  const frames: Frame[] = [];
  const enter = (target: DescriptorFunction): void => {
    active.add(target);
    frames.push({ fn: target, parameters: parametersFor(target), writes: new Map(), keys: new Map(),
      pending: target.body ? [target.body] : [], visited: new WeakSet() });
  };
  const cached = summaries.get(fn);
  if (cached) return cached;
  enter(fn);
  while (frames.length) {
    budget.take();
    const frame = frames[frames.length - 1];
    if (frame.waiting) {
      apply(frame, summaries.get(frame.waiting.fn)!, frame.waiting.args);
      frame.waiting = undefined;
    }
    const node = frame.parameters.size ? frame.pending.pop() : undefined;
    if (!node) {
      // Never publish an unfinished summary when traversal exhausts its budget.
      summaries.set(frame.fn, frame.writes);
      active.delete(frame.fn);
      frames.pop();
      continue;
    }
    if (ts.isFunctionLike(node)) continue;
    const parameters = frame.parameters;
    ts.forEachChild(node, child => { frame.pending.push(child); });
    const target = writeTarget(node);
    if (target) for (const member of assignmentTargets(target, frame.visited, budget)) {
      if (ts.isIdentifier(member)) continue;
      const path = pathFor(member.expression, parameters);
      if (path) mark(frame, path, memberKey(member, parameters));
    }
    if (ts.isCallExpression(node) && node.arguments.length) {
      const kind = unrefMutatorKind(node, aliases, budget);
      const prototypeWrite = !kind && node.arguments.length >= 2
        && nativeTimerObjectMethod(node.expression, aliases, budget)?.key === "setPrototypeOf";
      if (kind || prototypeWrite) {
        const path = pathFor(node.arguments[0], parameters);
        if (path) for (const key of kind === "property" ? [keyFor(node.arguments[1], parameters)]
          : kind ? patchMutationKeys(node, kind, aliases, nativeKeys, budget) : [undefined]) mark(frame, path, key);
      } else {
        const invocation = descriptorInvocation(node, aliases, budget);
        if (invocation?.fn.body) {
          const { fn: helper, args } = invocation;
          const cached = summaries.get(helper);
          if (cached) apply(frame, cached, args);
          else if (active.has(helper)) {
            for (const argument of args) {
              budget.take();
              const path = pathFor(argument, parameters);
              if (path) mark(frame, { index: path.index, members: [] }, undefined);
            }
          } else {
            frame.waiting = invocation;
            enter(helper);
          }
        }
      }
    }
  }
  return summaries.get(fn)!;
}

/** Gather property writes first so cached patch shapes do not depend on AST scan order. */
function unrefPatchWrites(workspace: Workspace, aliases: WeakMap<ts.Symbol, ts.Expression>,
  orderedBlocks: WeakMap<ts.Block, boolean>, budget: AnalysisBudget): PatchWrites {
  const mutations = new WeakMap<ts.ObjectLiteralExpression, PatchWrite[]>();
  const hiddenThrough = new WeakMap<ts.ObjectLiteralExpression, number[]>();
  const unordered = new WeakSet<ts.ObjectLiteralExpression>();
  const touched = new Set<ts.ObjectLiteralExpression>();
  const changedProperties = new WeakMap<ts.ObjectLiteralExpression, Set<string> | null>();
  const writeInterceptors = new WeakMap<ts.ObjectLiteralExpression, Set<string> | null>();
  const parameterWrites = new WeakMap<DescriptorFunction, DescriptorWrites>();
  const nativeKeys = new WeakMap<ts.ObjectLiteralExpression, ReadonlySet<string> | null>();
  interface AppliedWrites {
    earlyCall: ts.CallExpression;
    position: number;
    effects: Array<{ receiver: ts.ObjectLiteralExpression; key: string | undefined }>;
    replay: Set<ts.ObjectLiteralExpression>;
  }
  const appliedWrites = new WeakMap<DescriptorWrite[], WeakMap<ts.ObjectLiteralExpression, AppliedWrites>>();
  const pendingEffects: AppliedWrites[] = [];
  const dynamicWrites = new WeakMap<DescriptorWrite[], DescriptorWrite[]>();
  const orderedChanges = new WeakMap<ts.ObjectLiteralExpression, Map<string | undefined, number>>();
  const mayChange = (object: ts.ObjectLiteralExpression, key: string): boolean => {
    const changed = changedProperties.get(object);
    return changed === null || !!changed?.has(key);
  };
  function changed(target: ts.ObjectLiteralExpression, key: string | undefined, operation: ts.Node): void {
    const knownKey = key === "__proto__" ? undefined : key;
    const changes = orderedChanges.get(target) ?? new Map<string | undefined, number>();
    const previous = changes.get(knownKey);
    if (previous !== -1) {
      const position = operation.getSourceFile() === target.getSourceFile()
        ? orderedPatchPosition(operation, orderedBlocks, budget) : -1;
      changes.set(knownKey, Math.min(position, previous ?? Infinity));
      orderedChanges.set(target, changes);
    }
    if (changedProperties.get(target) === null) return;
    if (key === undefined || key === "__proto__") {
      changedProperties.set(target, null);
    } else {
      const keys = changedProperties.get(target) ?? new Set<string>();
      keys.add(key);
      changedProperties.set(target, keys);
    }
  }
  function assignmentKey(target: ts.ObjectLiteralExpression, key: string | undefined): string | undefined {
    if (key === undefined || key === "__proto__") return undefined;
    let interceptors = writeInterceptors.get(target);
    if (interceptors === undefined) {
      interceptors = new Set();
      for (const property of target.properties) {
        budget.take();
        const name = property.name;
        if (!name || ts.isComputedPropertyName(name) || ts.isIdentifier(name) && name.text === "__proto__"
          || ts.isStringLiteralLike(name) && name.text === "__proto__") {
          interceptors = null;
          break;
        }
        if ((ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && ts.isSetAccessorDeclaration(property)) {
          interceptors.add(name.text);
        }
      }
      writeInterceptors.set(target, interceptors);
    }
    return interceptors === null || interceptors.has(key) ? undefined : key;
  }
  const visitedTargets = new WeakSet<ts.Expression>();
  const patchMembers = new WeakMap<ts.ObjectLiteralExpression, Map<string, ts.Expression> | null>();
  const unresolvedMembers = new WeakSet<ts.ObjectLiteralExpression>();
  const writePaths = new WeakMap<ts.Expression, ts.ObjectLiteralExpression | null>();
  const writtenObject = (expression: ts.Expression): ts.ObjectLiteralExpression | undefined =>
    patchObject(expression, aliases, patchMembers, unresolvedMembers, writePaths, budget);
  function changedBefore(object: ts.ObjectLiteralExpression, key: string, operation: ts.Node): boolean {
    if (!mayChange(object, key)) return false;
    const changes = orderedChanges.get(object)!;
    const first = Math.min(changes.get(key) ?? Infinity, changes.get(undefined) ?? Infinity);
    if (first < 0 || operation.getSourceFile() !== object.getSourceFile()) return true;
    const position = orderedPatchPosition(operation, orderedBlocks, budget);
    return position < 0 || first <= position;
  }
  const mapAssignments = new WeakMap<ts.ObjectLiteralExpression, { operation: ts.Node; value: ts.Expression } | null>();
  const descriptorWrites: Array<{ target: ts.ObjectLiteralExpression; call: ts.CallExpression; map: boolean }> = [];
  function record(target: ts.ObjectLiteralExpression, operation: ts.Node, source?: ts.Expression, hidesUnref?: boolean): void {
    const position = orderedPatchPosition(operation, orderedBlocks, budget);
    if (position < 0 || operation.getSourceFile() !== target.getSourceFile()) unordered.add(target);
    let writes = mutations.get(target);
    if (!writes) { writes = []; mutations.set(target, writes); touched.add(target); }
    writes.push({ operation, position, source, hidesUnref });
  }
  for (const { sf } of workspace.units) {
    const pending: ts.Node[] = [sf];
    while (pending.length) {
      budget.take();
      const node = pending.pop()!;
      const target = writeTarget(node);
      if (target) for (const member of assignmentTargets(target, visitedTargets, budget)) {
        if (ts.isIdentifier(member)) continue;
        const receiver = writtenObject(member.expression);
        if (!receiver) continue;
        const key = assignmentKey(receiver, patchMemberKey(member, aliases, budget));
        if (!mayChange(receiver, "unref") && key === "unref" && ts.isBinaryExpression(node)
          && node.left === member && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          mapAssignments.set(receiver, { operation: node, value: node.right });
        } else if (key === "unref" || key === undefined || key === "__proto__") mapAssignments.set(receiver, null);
        changed(receiver, key, node);
        if (key === "unref" || key === undefined) record(receiver, node);
      }
      if (ts.isCallExpression(node)) {
        const kind = unrefMutatorKind(node, aliases, budget);
        const prototypeWrite = !kind && node.arguments.length >= 2
          && nativeTimerObjectMethod(node.expression, aliases, budget)?.key === "setPrototypeOf";
        const target = (kind || prototypeWrite) && writtenObject(node.arguments[0]);
        if (target) {
          const keys = kind ? patchMutationKeys(node, kind, aliases, nativeKeys, budget) : [undefined];
          for (const property of keys) {
            budget.take();
            const key = kind === "copy" ? assignmentKey(target, property) : property;
            changed(target, key, node);
            if (key === undefined || key === "unref" || key === "__proto__") mapAssignments.set(target, null);
          }
          if (kind === "copy") {
            for (let index = 1; index < node.arguments.length; index++) {
              budget.take();
              record(target, node, node.arguments[index]);
            }
          } else if (kind === "descriptorMap") {
            descriptorWrites.push({ target, call: node, map: true });
          } else if (kind === "property" && mayNameUnref(initializedAlias(node.arguments[1], aliases, budget))) {
            if (nativeTimerObjectMethod(node.expression, aliases, budget)?.key === "defineProperty") {
              descriptorWrites.push({ target, call: node, map: false });
            } else record(target, node);
          }
        } else if (!kind && !prototypeWrite && node.arguments.length) {
          const invocation = descriptorInvocation(node, aliases, budget);
          if (invocation?.fn.body) {
            const { fn, args } = invocation;
            let writes = parameterWrites.get(fn);
            if (!writes) {
              writes = descriptorParameterWrites(fn, aliases, nativeKeys, budget, parameterWrites);
              parameterWrites.set(fn, writes);
            }
            for (const [index, entries] of writes) {
              budget.take();
              const argument = args[index];
              const object = argument && writtenObject(argument);
              if (!object) continue;
              let applied = appliedWrites.get(entries);
              if (!applied) { applied = new WeakMap(); appliedWrites.set(entries, applied); }
              let recorded = applied.get(object);
              const position = node.getSourceFile() === object.getSourceFile() ? orderedPatchPosition(node, orderedBlocks, budget) : -1;
              const first = !recorded;
              if (!recorded) {
                recorded = { earlyCall: node, position, effects: [], replay: new Set() };
                applied.set(object, recorded);
                pendingEffects.push(recorded);
              } else if (position < recorded.position) {
                recorded.position = position;
                recorded.earlyCall = node;
              }
              let dynamic = dynamicWrites.get(entries);
              if (!dynamic) {
                dynamic = entries.filter(entry => {
                  budget.take();
                  return entry.dynamic;
                });
                dynamicWrites.set(entries, dynamic);
              }
              for (const receiver of recorded.replay) { budget.take(); record(receiver, node); }
              const resolveKey = (key: DescriptorKey | undefined) => {
                if (typeof key !== "number") return key;
                const argument = args[key];
                return argument && patchPropertyKey(argument, aliases, budget);
              };
              for (const { members, key: property, dynamic: dynamicEntry } of first ? entries : dynamic) {
                budget.take();
                const resolved: string[] = [];
                for (const member of members) {
                  budget.take();
                  const key = resolveKey(member);
                  if (key === undefined) break;
                  resolved.push(key);
                }
                if (resolved.length !== members.length) continue;
                const receiver = members.length ? resolvePatchObject(object, aliases, patchMembers, unresolvedMembers, budget, undefined, resolved) : object;
                if (!receiver) continue;
                const key = assignmentKey(receiver, resolveKey(property));
                if (dynamicEntry) changed(receiver, key, node);
                else recorded.effects.push({ receiver, key });
                if (key === undefined || key === "unref") {
                  mapAssignments.set(receiver, null);
                  record(receiver, node);
                  if (!dynamicEntry) recorded.replay.add(receiver);
                }
              }
            }
          }
        }
      }
      ts.forEachChild(node, child => { pending.push(child); });
    }
  }
  for (const { earlyCall, effects } of pendingEffects) {
    budget.take();
    for (const { receiver, key } of effects) { budget.take(); changed(receiver, key, earlyCall); }
  }
  // Descriptors are read when the native call executes. Later writes cannot
  // change the flags already installed on the receiving object.
  const descriptorsByObject = new WeakMap<ts.ObjectLiteralExpression, DescriptorEnumeration>();
  const mapEntries = new WeakMap<ts.ObjectLiteralExpression, DescriptorMapEntry>();
  const stableMaps = new WeakMap<ts.ObjectLiteralExpression, DescriptorEnumeration>();
  for (const { target, call, map } of descriptorWrites) {
    budget.take();
    const paths = new WeakMap<ts.Expression, ts.ObjectLiteralExpression | null>();
    let stable = true;
    const changedAtCall = (object: ts.ObjectLiteralExpression, key: string) => {
      if (!mayChange(object, key)) return false;
      stable = false;
      return changedBefore(object, key, call);
    };
    const readObject = (expression: ts.Expression) =>
      patchObject(expression, aliases, patchMembers, unresolvedMembers, paths, budget, changedAtCall);
    const enumeration = (expression: ts.Expression | undefined): DescriptorEnumeration =>
      descriptorEnumeration(expression && readObject(expression), aliases, changedAtCall, descriptorsByObject, budget);
    let state: DescriptorEnumeration;
    if (map) {
      const descriptors = readObject(call.arguments[1]);
      state = "unknown";
      if (descriptors && !changedAtCall(descriptors, "unref") && !unresolvedMembers.has(descriptors)) {
        const cached = stableMaps.get(descriptors);
        if (cached !== undefined) state = cached;
        else {
          stable = true;
          let entry = mapEntries.get(descriptors);
          if (entry === undefined) {
            entry = descriptorMapEntry(descriptors, aliases, budget);
            mapEntries.set(descriptors, entry);
          }
          state = typeof entry === "string" ? entry : enumeration(entry);
          if (stable) stableMaps.set(descriptors, state);
        }
      } else if (descriptors && !unresolvedMembers.has(descriptors)) {
        const assignment = mapAssignments.get(descriptors);
        if (assignment && descriptors.properties.length === 0
          && descriptors.getSourceFile() === call.getSourceFile()) {
          const write = orderedPatchPosition(assignment.operation, orderedBlocks, budget);
          const read = orderedPatchPosition(call, orderedBlocks, budget);
          if (write >= 0 && read >= 0) state = write < read ? enumeration(assignment.value) : "omitted";
        }
      }
    } else state = enumeration(call.arguments[2]);
    if (state === "maybeEnumerable") record(target, call);
    else if (state === "unknown") record(target, call, map ? call.arguments[1] : undefined);
    else if (state === "hidden") record(target, call, undefined, true);
  }
  for (const target of touched) {
    budget.take();
    if (unordered.has(target)) continue;
    const writes = mutations.get(target)!;
    writes.sort((left, right) => {
      budget.take();
      return left.position - right.position;
    });
    if (writes.some(write => { budget.take(); return write.hidesUnref; })) {
      const hidden = [0];
      for (let index = 0; index < writes.length; index++) {
        budget.take();
        hidden.push(writes[index].hidesUnref ? index + 1 : hidden[index]);
      }
      hiddenThrough.set(target, hidden);
    }
  }
  return { mutations, hiddenThrough, unordered, orderedBlocks };
}

/** Resolve object-valued literal members reached through unchanged bindings. */
function patchObject(expression: ts.Expression, aliases: WeakMap<ts.Symbol, ts.Expression>,
  patchMembers: WeakMap<ts.ObjectLiteralExpression, Map<string, ts.Expression> | null>,
  unresolvedMembers: WeakSet<ts.ObjectLiteralExpression>,
  cache: WeakMap<ts.Expression, ts.ObjectLiteralExpression | null>, budget: AnalysisBudget,
  changed?: (object: ts.ObjectLiteralExpression, key: string) => boolean): ts.ObjectLiteralExpression | undefined {
  const root = initializedAlias(expression, aliases, budget);
  if (ts.isObjectLiteralExpression(root)) return root;
  const binding = ts.isIdentifier(root) && symbolOf(root)?.valueDeclaration;
  const declaration = binding && ts.isBindingElement(binding) && binding.parent.parent;
  const key = declaration && ts.isVariableDeclaration(declaration) && declaration.end <= root.pos
    && ts.isIdentifier(binding.name) ? binding.name : root;
  const cached = cache.get(key);
  if (cached !== undefined) return cached ?? undefined;
  const result = resolvePatchObject(root, aliases, patchMembers, unresolvedMembers, budget, changed);
  cache.set(key, result ?? null);
  return result;
}

function resolvePatchObject(value: ts.Expression, aliases: WeakMap<ts.Symbol, ts.Expression>,
  patchMembers: WeakMap<ts.ObjectLiteralExpression, Map<string, ts.Expression> | null>,
  unresolvedMembers: WeakSet<ts.ObjectLiteralExpression>, budget: AnalysisBudget,
  changed?: (object: ts.ObjectLiteralExpression, key: string) => boolean,
  suffix: readonly string[] = []): ts.ObjectLiteralExpression | undefined {
  budget.take(suffix.length);
  const members = [...suffix].reverse();
  const path = new Set<ts.Expression>();
  while (true) {
    budget.take();
    if (path.has(value)) return undefined;
    path.add(value);
    if (ts.isIdentifier(value)) {
      const binding = symbolOf(value)?.valueDeclaration;
      if (!binding || !ts.isBindingElement(binding) || binding.initializer || binding.dotDotDotToken
        || !ts.isObjectBindingPattern(binding.parent)) return undefined;
      const declaration = binding.parent.parent;
      const key = binding.propertyName ?? binding.name;
      if (!ts.isVariableDeclaration(declaration) || !declaration.initializer
        || !(declaration.parent.flags & ts.NodeFlags.Const) || declaration.end > value.pos
        || !ts.isIdentifier(key) && !ts.isStringLiteralLike(key)) return undefined;
      members.push(key.text);
      value = initializedAlias(declaration.initializer, aliases, budget);
    } else if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const key = ts.isPropertyAccessExpression(value) ? value.name : initializedAlias(value.argumentExpression, aliases, budget);
      if (!ts.isPropertyAccessExpression(value) && !ts.isStringLiteralLike(key)) return undefined;
      if (!ts.isIdentifier(key) && !ts.isStringLiteralLike(key)) return undefined;
      members.push(key.text);
      value = initializedAlias(value.expression, aliases, budget);
    } else if (ts.isObjectLiteralExpression(value)) {
      const key = members.pop();
      if (key === undefined) return value;
      if (changed?.(value, key)) return undefined;
      let known = patchMembers.get(value);
      if (known === undefined) {
        known = new Map();
        for (const property of value.properties) {
          budget.take();
          const name = property.name;
          if (!name || ts.isComputedPropertyName(name)) { known = null; break; }
          if (!ts.isIdentifier(name) && !ts.isStringLiteralLike(name)) continue;
          if (ts.isPropertyAssignment(property)) known.set(name.text, property.initializer);
          else if (ts.isShorthandPropertyAssignment(property)) known.set(name.text, property.name);
          else known.delete(name.text);
        }
        patchMembers.set(value, known);
      }
      const member = known?.get(key);
      if (!member) {
        if (key === "unref") unresolvedMembers.add(value);
        return undefined;
      }
      value = initializedAlias(member, aliases, budget);
    } else return undefined;
  }
}

type DescriptorEnumeration = "unknown" | "maybeEnumerable" | "hidden" | "omitted";
type DescriptorMapEntry = ts.Expression | "unknown" | "maybeEnumerable" | "omitted";

/** Select the final entry once. Its descriptor flags are read at each installation. */
function descriptorMapEntry(descriptors: ts.ObjectLiteralExpression, aliases: WeakMap<ts.Symbol, ts.Expression>,
  budget: AnalysisBudget): DescriptorMapEntry {
  for (let index = descriptors.properties.length - 1; index >= 0; index--) {
    budget.take();
    const property = descriptors.properties[index];
    if (ts.isSpreadAssignment(property)) return "unknown";
    const name = property.name;
    if (!name) continue;
    const key = ts.isComputedPropertyName(name) ? patchPropertyKey(name.expression, aliases, budget)
      : ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined;
    if (key === undefined) return "unknown";
    if (key !== "unref") continue;
    if (ts.isPropertyAssignment(property)) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property)) return property.name;
    return "maybeEnumerable";
  }
  return "omitted";
}

function descriptorEnumeration(descriptor: ts.ObjectLiteralExpression | undefined, aliases: WeakMap<ts.Symbol, ts.Expression>,
  changed: (object: ts.ObjectLiteralExpression, key: string) => boolean, cache: WeakMap<ts.ObjectLiteralExpression, DescriptorEnumeration>,
  budget: AnalysisBudget): DescriptorEnumeration {
  if (!descriptor || changed(descriptor, "enumerable")) return "maybeEnumerable";
  const cached = cache.get(descriptor);
  if (cached !== undefined) return cached;
  const state = literalDescriptorEnumeration(descriptor, aliases, budget);
  cache.set(descriptor, state);
  return state;
}

function literalDescriptorEnumeration(descriptor: ts.ObjectLiteralExpression, aliases: WeakMap<ts.Symbol, ts.Expression>,
  budget: AnalysisBudget): DescriptorEnumeration {
  let state: DescriptorEnumeration = "omitted";
  for (const property of descriptor.properties) {
    budget.take();
    if (ts.isSpreadAssignment(property) || property.name && ts.isComputedPropertyName(property.name)) return "maybeEnumerable";
    const name = property.name;
    if (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === "__proto__") return "maybeEnumerable";
    if (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === "enumerable") {
      const value = ts.isPropertyAssignment(property) ? initializedAlias(property.initializer, aliases, budget) : undefined;
      state = value && (literalTruth(value, budget) === false || literalNullish(value, budget) === true)
        ? "hidden" : "maybeEnumerable";
    }
  }
  return state;
}

function patchWriteCount(source: ts.ObjectLiteralExpression, operation: ts.Node, writes: PatchWrites,
  budget: AnalysisBudget): number {
  const mutations = writes.mutations.get(source);
  if (!mutations?.length) return 0;
  if (writes.unordered.has(source) || source.getSourceFile() !== operation.getSourceFile()) return mutations.length;
  const position = orderedPatchPosition(operation, writes.orderedBlocks, budget);
  if (position < 0) return mutations.length;
  let left = 0;
  let right = mutations.length;
  while (left < right) {
    budget.take();
    const middle = (left + right) >>> 1;
    if (mutations[middle].position < position) left = middle + 1;
    else right = middle;
  }
  return left;
}

function orderedPatchPosition(operation: ts.Node, orderedBlocks: WeakMap<ts.Block, boolean>,
  budget: AnalysisBudget): number {
  let expression = ts.isSpreadAssignment(operation) ? operation.parent : operation;
  while (unwrapParent(expression.parent)) {
    budget.take();
    expression = expression.parent;
  }
  const binding = expression.parent;
  if (ts.isVariableDeclaration(binding) && binding.initializer === expression && ts.isVariableDeclarationList(binding.parent)
    && ts.isVariableStatement(binding.parent.parent)) {
    return orderedStartupScope(binding.parent.parent.parent, orderedBlocks, budget) ? operation.pos : -1;
  }
  return orderedWritePosition(operation, orderedBlocks, budget);
}

function unrefPatch(expression: ts.Expression, operation: ts.Node, aliases: WeakMap<ts.Symbol, ts.Expression>,
  writes: PatchWrites, shapes: PatchShapes, budget: AnalysisBudget): boolean {
  const root = initializedAlias(expression, aliases, budget);
  if (!ts.isObjectLiteralExpression(root)) return !primitivePatch(root);
  function snapshot(source: ts.ObjectLiteralExpression, at: ts.Node): { source: ts.ObjectLiteralExpression;
    count: number; hidden: number; shape: PatchShape } {
    const count = patchWriteCount(source, at, writes, budget);
    const hiddenVersions = writes.hiddenThrough.get(source);
    const hidden = hiddenVersions && at.getSourceFile() === source.getSourceFile()
      && orderedPatchPosition(at, writes.orderedBlocks, budget) >= 0
      ? hiddenVersions[count] : 0;
    let versions = shapes.get(source);
    if (!versions) { versions = new Map(); shapes.set(source, versions); }
    let shape = versions.get(hidden);
    if (!shape) { shape = { safeThrough: -1, unsafeFrom: Infinity }; versions.set(hidden, shape); }
    return { source, count, hidden, shape };
  }
  const rootSnapshot = snapshot(root, operation);
  const { shape: rootShape, count: rootCount } = rootSnapshot;
  if (rootCount <= rootShape.safeThrough) return false;
  if (rootCount >= rootShape.unsafeFrom) return true;
  function markUnsafe(): true {
    rootShape.unsafeFrom = Math.min(rootShape.unsafeFrom, rootCount);
    return true;
  }
  const pending = [rootSnapshot];
  const visited = new Map<PatchShape, number>();
  function include(expression: ts.Expression, operation: ts.Node): boolean {
    const value = initializedAlias(expression, aliases, budget);
    if (!ts.isObjectLiteralExpression(value)) return !primitivePatch(value);
    pending.push(snapshot(value, operation));
    return false;
  }
  while (pending.length) {
    budget.take();
    const { source, count, hidden, shape } = pending.pop()!;
    if (count >= shape.unsafeFrom) return markUnsafe();
    const coveredThrough = Math.max(shape.safeThrough, visited.get(shape) ?? -1);
    if (count <= coveredThrough) continue;
    visited.set(shape, count);
    const mutations = writes.mutations.get(source);
    // A definite non-enumerable definition erases earlier copy evidence.
    // Within each such version, only the newly observed writes need checking.
    for (let index = Math.max(hidden, coveredThrough); mutations && index < count; index++) {
      budget.take();
      const { operation, source: patch, hidesUnref } = mutations[index];
      if (hidesUnref) continue;
      if (!patch || include(patch, operation)) return markUnsafe();
    }
    if (hidden || coveredThrough >= 0) continue;
    for (const property of source.properties) {
      budget.take();
      if (ts.isSpreadAssignment(property)) {
        if (include(property.expression, property)) return markUnsafe();
      } else if (property.name) {
        const name = property.name;
        const mayReplace = ts.isComputedPropertyName(name) ? mayNameUnref(initializedAlias(name.expression, aliases, budget))
          : (ts.isStringLiteralLike(name) || ts.isIdentifier(name)) && name.text === "unref";
        if (mayReplace) return markUnsafe();
      }
    }
  }
  for (const [shape, count] of visited) {
    budget.take();
    shape.safeThrough = count;
  }
  return false;
}

function unrefMutator(call: ts.CallExpression, aliases: WeakMap<ts.Symbol, ts.Expression>,
  writes: PatchWrites, shapes: PatchShapes, prototypes: WeakMap<ts.Expression, boolean>,
  summaries: WeakMap<ts.Declaration, HelperRegistration | null>, budget: AnalysisBudget): boolean {
  const kind = unrefMutatorKind(call, aliases, budget);
  if (!kind || !intervalPrototype(call.arguments[0], aliases, prototypes, summaries, budget)) return false;
  if (kind === "descriptorMap") return unrefPatch(call.arguments[1], call, aliases, writes, shapes, budget);
  if (kind === "copy") {
    for (let i = 1; i < call.arguments.length; i++) {
      budget.take();
      if (unrefPatch(call.arguments[i], call, aliases, writes, shapes, budget)) return true;
    }
    return false;
  }
  return mayNameUnref(initializedAlias(call.arguments[1], aliases, budget));
}

function* assignmentTargets(target: ts.Expression, visitedTargets: WeakSet<ts.Expression>,
  budget: AnalysisBudget): Iterable<ts.Identifier | ts.PropertyAccessExpression | ts.ElementAccessExpression> {
  const pending = [target];
  while (pending.length) {
    budget.take();
    const node = pending.pop()!;
    if (visitedTargets.has(node)) continue;
    visitedTargets.add(node);
    if (unwrapParent(node)) {
      pending.push(node.expression);
    } else if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      yield node;
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) pending.push(element);
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) pending.push(property.initializer);
        else if (ts.isShorthandPropertyAssignment(property)) pending.push(property.name);
        else if (ts.isSpreadAssignment(property)) pending.push(property.expression);
      }
    } else if (ts.isSpreadElement(node)) pending.push(node.expression);
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) pending.push(node.left);
  }
}

function indexWrites(target: ts.Expression, operation: ts.Node, names: Set<string>, handles: Set<ts.Symbol>,
  firstHandleWrites: Map<ts.Symbol, number>, replacedTimers: TimerWrites, writtenNames: Set<string>,
  visitedTargets: WeakSet<ts.Expression>, orderedBlocks: WeakMap<ts.Block, boolean>,
  globalAliases: WeakMap<ts.Symbol, boolean>, timerAliases: WeakMap<ts.Symbol, ts.Expression>,
  loopWrites: LoopWrites, budget: AnalysisBudget): boolean {
  let writePosition: number | undefined;
  for (const node of assignmentTargets(target, visitedTargets, budget)) {
    if (!ts.isIdentifier(node)) {
      const receiver = unwrap(node.expression, budget);
      if (nativeArrayPrototype(receiver, budget)) return true;
      if (namedAccess(node, "length") && ts.isIdentifier(receiver)) {
        const queue = privateQueues.get(budget)?.get(symbolOf(receiver)!);
        if (queue) queue.excluded = true;
      }
    }
    if (ts.isIdentifier(node)) writtenNames.add(node.text);
    const indexed = ts.isElementAccessExpression(node) ? node : undefined;
    const key = indexed && initializedAlias(indexed.argumentExpression, timerAliases, budget);
    for (const method of TRACKED_HOST_METHODS) {
      const receiver = indexed && key && (!primitivePatch(key) || ts.isStringLiteralLike(key) && key.text === method)
        ? indexed.expression : namedAccess(node, method);
      if ((ts.isIdentifier(node) && node.text === method && hostIdentifier(node))
        || (receiver && aliasesHostGlobal(receiver, globalAliases, budget))) {
        recordTimerWrite(method, operation, replacedTimers, orderedBlocks, budget);
      }
    }
    if (!ts.isIdentifier(node)) continue;
    const symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? checkerFor(node.getSourceFile()).getShorthandAssignmentValueSymbol(node.parent) : symbolOf(node);
    if (symbol) addLoopWrite(loopWrites.bindings, symbol, node.pos);
    if (names.has(node.text) && symbol && handles.has(symbol)) {
      writePosition ??= orderedWritePosition(operation, orderedBlocks, budget);
      firstHandleWrites.set(symbol, Math.min(firstHandleWrites.get(symbol) ?? Infinity, writePosition));
    }
  }
  return false;
}

/** A direct startup write has a source order. Other writes can run through earlier calls. */
function orderedWritePosition(operation: ts.Node, orderedBlocks: WeakMap<ts.Block, boolean>, budget: AnalysisBudget): number {
  let expression = operation;
  while (unwrapParent(expression.parent)) {
    budget.take();
    expression = expression.parent;
  }
  if (!ts.isExpressionStatement(expression.parent)) return -1;
  return orderedStartupScope(expression.parent.parent, orderedBlocks, budget) ? operation.pos : -1;
}

function orderedStartupScope(scope: ts.Node, orderedBlocks: WeakMap<ts.Block, boolean>, budget: AnalysisBudget): boolean {
  const path: ts.Block[] = [];
  let ordered: boolean | undefined;
  while (ts.isBlock(scope)) {
    budget.take();
    ordered = orderedBlocks.get(scope);
    if (ordered !== undefined) break;
    path.push(scope);
    scope = scope.parent;
  }
  ordered ??= ts.isSourceFile(scope);
  for (const block of path) { budget.take(); orderedBlocks.set(block, ordered); }
  return ordered;
}

function nativeArrayPrototype(node: ts.Node, budget: AnalysisBudget): boolean {
  const base = namedAccess(node, "prototype");
  if (!base) return false;
  const constructor = unwrap(base, budget);
  const global = namedAccess(constructor, "Array");
  return !!global && globalObject(global) || ts.isIdentifier(constructor) && constructor.text === "Array" && hostIdentifier(constructor);
}

function nativeMethodsUncertain(node: ts.Node, budget: AnalysisBudget): boolean {
  if (!nativeArrayPrototype(node, budget)) return false;
  let use = node;
  while (unwrapParent(use.parent)) { budget.take(); use = use.parent; }
  const parent = use.parent;
  if (ts.isTypeOfExpression(parent) || ts.isVoidExpression(parent) || ts.isExpressionStatement(parent)) return false;
  if (!(ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) || parent.expression !== use) return true;
  const key = ts.isPropertyAccessExpression(parent) ? parent.name.text
    : ts.isStringLiteralLike(parent.argumentExpression) ? parent.argumentExpression.text : undefined;
  let member: ts.Node = parent;
  while (unwrapParent(member.parent)) { budget.take(); member = member.parent; }
  const effect = member.parent;
  if (ts.isTypeOfExpression(effect) || ts.isVoidExpression(effect) || ts.isExpressionStatement(effect)) return false;
  // A method invoked on the prototype receives the prototype itself. An
  // unknown implementation can mutate it, and valueOf() returns it directly.
  if (ts.isCallExpression(effect) && effect.expression === member) {
    return !key || !["slice", "at", "includes", "indexOf", "lastIndexOf"].includes(key);
  }
  // Reading a native member (e.g. slice.call(arguments)) cannot rebind the
  // methods used by the queue. Actual writes are indexed, including patterns.
  // An unknown member or prototype/descriptor method can expose or patch it.
  return !key || ["constructor", "__proto__", "__defineGetter__", "__defineSetter__"].includes(key);
}
