import ts from "typescript";
import { AnalysisBudget, AnalysisLimitError, projectWorkLimit } from "./analysisBudget.js";
import { definitionOf, importedBinding, projectFor, symbolOf } from "./bindings.js";
import type { Workspace } from "./workspace.js";

type Callable = ts.FunctionLikeDeclaration & { body: ts.ConciseBody };
interface Value { node: ts.Node; env: Environment; bound?: { id: number; args: Value[][]; receiver?: Value }; memberReceiver?: Value; fieldOwner?: { id: number; owner: ts.ClassLikeDeclaration; env: Environment; fields: ReadonlySet<ts.PropertyDeclaration>; before?: ts.PropertyDeclaration; previous?: Value["fieldOwner"] } }
interface Environment { id: number; fn?: ts.FunctionLikeDeclaration; closure?: Environment; parameters: Map<ts.Declaration, Value[]>; receiver?: Value; constructionReady?: boolean; fieldPhase?: { owner: ts.ClassLikeDeclaration; before: ts.PropertyDeclaration } }
interface Write { value: ts.Expression; node: ts.BinaryExpression; scope?: ts.FunctionLikeDeclaration; definite: boolean }
interface ParameterState { order: ReadonlyMap<ts.Declaration, number>; cursor: number }
interface Work { node: ts.Node; env: Environment; request?: boolean; initializations?: Array<[Environment, ParameterState]> }
const HTTP_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all", "use", "route"]);
const CALLBACK_METHODS = new Set(["forEach", "map", "flatMap", "filter", "reduce", "reduceRight", "some", "every", "find", "findIndex", "sort", "then", "catch", "finally"]);
function enclosing(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) if (ts.isFunctionLike(parent)) return parent as ts.FunctionLikeDeclaration;
  return undefined;
}
function transparent(node: ts.Node): node is ts.ParenthesizedExpression | ts.AsExpression | ts.TypeAssertion | ts.NonNullExpression | ts.SatisfiesExpression {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node);
}
function propertyName(node: ts.PropertyName | ts.Expression | undefined): string | undefined {
  return node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) ? node.text : undefined;
}
function callable(node: ts.Node): node is Callable {
  return ts.isFunctionLike(node) && !!(node as ts.FunctionLikeDeclaration).body;
}

/** Per-call evidence, distinct from module import reachability. Unknown callback
 * execution remains possible evidence rather than a verified request path. */
export interface RequestReachability { evidence(node: ts.CallExpression): "request" | "possible" | undefined }
export function requestReachability(workspace: Workspace): RequestReachability {
  const budget = new AnalysisBudget("Request reachability", projectWorkLimit(workspace.units.map(unit => unit.sf)));
  const evidence = new WeakMap<ts.CallExpression, boolean>();
  const writes = new Map<ts.Declaration, Write[]>();
  const definiteWrites = new Set<ts.Node>();
  const unsafeReceivers = new Set<ts.Node>();
  const unsafeCallables = new Set<ts.Node>();
  const mutatedCollections = new Set<ts.Node>();
  const mutatedCollectionGlobals = new Set<string>();
  const reshapedCollections = new Set<ts.Node>();
  // General binding resolution exposes array elements to callback lists. Keep
  // the original container alongside that immutable union for helper arguments.
  const collectionContainers = new WeakMap<Value[], Value>();
  // Callback-list resolution exposes array elements. Preserve their runtime
  // alternatives separately when unions/factory returns combine those lists.
  const runtimeUnions = new WeakMap<Value[], { values: Value[]; keys: Set<string> }>();
  const boundValues = new WeakMap<ts.CallExpression, Map<string, BindingSummary>>();
  let nextBound = 1;
  const properties = new WeakMap<ts.ObjectLiteralExpression, Map<string, ts.Node>>();
  const fieldEnvironments = new WeakMap<ts.PropertyDeclaration, Map<string, Environment>>();
  const ids = new WeakMap<ts.Node, number>();
  let nextId = 1, nextEnvironment = 1;
  const empty: Environment = { id: 0, parameters: new Map() };
  const work: Work[] = [];
  const activeInitializations = new Map<Environment, ParameterState>();
  // Deferred closures keep the canonical parameter environment. If binding
  // initialization fails, bindings beyond this final cursor never become
  // initialized, even after the caller has unwound or an async task suspends.
  const completedInitializations = new WeakMap<Environment, { state: ParameterState; exits: number }>();
  let failedInitializationCount = 0;
  const initializationSignature = (): string => {
    const parts: string[] = [];
    for (const [env, state] of activeInitializations) { budget.take(); parts.push(`${env.id}:${state.cursor}`); }
    return parts.join(",");
  };
  const enqueue = (task: Work, deferred = false): void => {
    if (!deferred && activeInitializations.size) {
      task.initializations = [];
      for (const entry of activeInitializations) { budget.take(); task.initializations.push(entry); }
    }
    work.push(task);
  };
  const restArrays = new WeakMap<ts.ArrayLiteralExpression, { items: Value[][]; spread: number }>();
  const restArguments = new WeakMap<Value[][], Map<number, Value[]>>();
  const restValues = (args: Value[][], index: number, env: Environment): Value[] => {
    let positions = restArguments.get(args);
    if (!positions) { positions = new Map(); restArguments.set(args, positions); }
    const cached = positions.get(index); if (cached) return cached;
    const items: Value[][] = []; let spread = Infinity;
    for (let position = index; position < args.length; position++) {
      budget.take(); const values = args[position];
      if (values.some(value => { budget.take(); return ts.isSpreadElement(value.node); })) spread = Math.min(spread, items.length);
      items.push(values);
    }
    const node = ts.factory.createArrayLiteralExpression();
    restArrays.set(node, { items, spread });
    const container: Value = { node, env }, values = [container];
    collectionContainers.set(values, container); positions.set(index, values); return values;
  };
  const invoked = new Set<string>();
  const registrationCandidates = new Set<ts.Node>();
  const registrationEvaluation = new WeakSet<ts.Node>();
  const factoryResults = new Map<string, BindingSummary>();
  const activeFactories = new Set<string>();
  const commonJsDefaults = new WeakMap<ts.SourceFile, ts.Expression | undefined>();
  const literalArrayValues = new WeakMap<ts.ArrayLiteralExpression, Map<Environment, Value[]>>();
  const literalArrayTemplates = new WeakMap<ts.ArrayLiteralExpression, Value[]>();
  const uncertainBindings = new Set<ts.Declaration>();
  let stableResolutionPhase = false;
  let resolutionCycles = 0;
  interface DeclarationResolution { values: Value[]; height: number; dependencies: Set<ts.Node> }
  interface BindingSummary extends DeclarationResolution { epoch: number }
  let declarationValues = new WeakMap<ts.Declaration, Map<string, DeclarationResolution>>();
  const resolutionFrames: Array<{ start: number; max: number; dependencies: Set<ts.Node> }> = [];
  let resolutionFacts = "", resolutionEpoch = 0;
  const startBinding = (depth: number, node: ts.Node): typeof resolutionFrames[number] => {
    const frame = { start: depth, max: depth, dependencies: new Set<ts.Node>([node]) };
    resolutionFrames.push(frame); return frame;
  };
  const bindingSummary = (values: Value[], frame: typeof resolutionFrames[number], epoch: number): BindingSummary => ({
    values, height: frame.max - frame.start, dependencies: frame.dependencies, epoch,
  });
  const reuseBinding = (summary: BindingSummary | undefined, seen: Set<ts.Node>): Value[] | undefined => {
    if (!summary || summary.epoch !== resolutionEpoch) return undefined;
    if (seen.size + summary.height > 128) throw new AnalysisLimitError("Request binding resolution depth limit exceeded");
    for (const ancestor of seen) { budget.take(); if (summary.dependencies.has(ancestor)) return undefined; }
    for (const frame of resolutionFrames) {
      budget.take(); frame.max = Math.max(frame.max, seen.size + summary.height);
      for (const dependency of summary.dependencies) { budget.take(); frame.dependencies.add(dependency); }
    }
    return summary.values;
  };
  const id = (node: ts.Node): number => { let value = ids.get(node); if (!value) { value = nextId++; ids.set(node, value); } return value; };
  const lexical = (node: ts.Node, env: Environment): Environment => {
    const scope = enclosing(node);
    if (!scope) return empty;
    for (let current: Environment | undefined = env; current; current = current.closure) {
      budget.take(); if (current.fn === scope) return current;
    }
    // An absent lexical owner is unknown, not the currently executing
    // callback's scope. Borrowing that scope manufactures fresh closures on
    // every recursive callback and can also mix unrelated parameter bindings.
    return empty;
  };
  const members = (object: ts.ObjectLiteralExpression): Map<string, ts.Node> => {
    let known = properties.get(object);
    if (known) return known;
    known = new Map();
    for (const member of object.properties) {
      budget.take();
      if (ts.isSpreadAssignment(member) || !member.name || ts.isComputedPropertyName(member.name)) { known.clear(); continue; }
      const name = propertyName(member.name); if (name !== undefined) known.set(name, member);
    }
    properties.set(object, known); return known;
  };
  const writeDeclarations = new WeakMap<ts.Declaration, ts.Declaration>();
  const classWriteDeclarations = new WeakMap<ts.ClassLikeDeclaration, Map<string, ts.Declaration>>();
  const writeDeclaration = (declaration: ts.Declaration): ts.Declaration => {
    const known = writeDeclarations.get(declaration); if (known) return known;
    let canonical = declaration;
    if ((ts.isPropertyDeclaration(declaration) || ts.isMethodDeclaration(declaration)) && (ts.isClassDeclaration(declaration.parent) || ts.isClassExpression(declaration.parent))) {
      let entries = classWriteDeclarations.get(declaration.parent);
      if (!entries) {
        entries = new Map();
        for (const member of declaration.parent.members) {
          budget.take();
          if (!ts.isPropertyDeclaration(member) && !ts.isMethodDeclaration(member)) continue;
          const name = propertyName(member.name); if (name === undefined) continue;
          const key = `${member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword) ? 1 : 0}:${name}`;
          if (!entries.has(key)) entries.set(key, member);
        }
        classWriteDeclarations.set(declaration.parent, entries);
      }
      const name = propertyName(declaration.name);
      const key = `${declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword) ? 1 : 0}:${name}`;
      canonical = entries.get(key) ?? declaration;
    }
    writeDeclarations.set(declaration, canonical); return canonical;
  };
  const overwrittenByField = (write: Write, declaration: ts.Declaration): boolean => {
    if (!ts.isPropertyDeclaration(declaration)) return false;
    for (let node: ts.Node | undefined = write.node.parent; node && node !== declaration.parent; node = node.parent) {
      budget.take();
      if (ts.isFunctionLike(node)) return false;
      if ((ts.isPropertyDeclaration(node) || ts.isClassStaticBlockDeclaration(node)) && node.parent === declaration.parent) return node.pos < declaration.pos;
    }
    return false;
  };
  const receiverDeclaration = (node: ts.Expression, seen = new Set<ts.Node>()): ts.Node | undefined => {
    budget.take();
    if (seen.has(node)) return undefined;
    if (seen.size > 128) throw new AnalysisLimitError("Request binding resolution depth limit exceeded");
    if (transparent(node)) return receiverDeclaration(node.expression, new Set(seen).add(node));
    if (!ts.isIdentifier(node)) return node.kind === ts.SyntaxKind.ThisKeyword ? node : undefined;
    const declaration = symbolOf(node)?.valueDeclaration ?? definitionOf(node);
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isIdentifier(declaration.initializer)) return receiverDeclaration(declaration.initializer, new Set(seen).add(node));
    return declaration;
  };
  const sameWriteReceiver = (write: Write, use: ts.Node): boolean => {
    if (!(ts.isPropertyAccessExpression(write.node.left) || ts.isElementAccessExpression(write.node.left))
      || !(ts.isPropertyAccessExpression(use) || ts.isElementAccessExpression(use))) return true;
    const written = receiverDeclaration(write.node.left.expression), read = receiverDeclaration(use.expression);
    if (written?.kind === ts.SyntaxKind.ThisKeyword || read?.kind === ts.SyntaxKind.ThisKeyword) return true;
    return !written || !read || written === read;
  };
  const replacement = (declaration: ts.Declaration, use: ts.Node): ts.Expression | null | undefined => {
    const indexed = writes.get(writeDeclaration(declaration));
    const values = indexed?.filter(write => { budget.take(); return !overwrittenByField(write, declaration) && sameWriteReceiver(write, use); });
    if (!values?.length) return undefined;
    const scope = enclosing(use);
    const local = values.filter(write => { budget.take(); return write.scope === scope && write.node.pos < use.pos; });
    const moduleWrites = values.filter(write => { budget.take(); return !write.scope && (scope || write.node.pos < use.pos); });
    const applicable = [...moduleWrites, ...local];
    // Writes from other callable scopes are uncertain; never recover a stale
    // original method solely from its declaration.
    if (values.some(write => { budget.take(); return write.scope && write.scope !== scope; }) || applicable.some(write => !write.definite)) return null;
    return applicable.at(-1)?.value;
  };
  const undefinedArgument = (value: Value): boolean => ts.isVoidExpression(value.node)
    || ts.isIdentifier(value.node) && value.node.text === "undefined" && !symbolOf(value.node)?.declarations?.length;
  const takesDefault = (values: Value[] | undefined): boolean => {
    if (values && collectionContainers.has(values)) return false;
    return !values?.length || values.some(value => {
      budget.take(); return undefinedArgument(value);
    });
  };
  // Arrow functions capture this from their lexical execution, including an
  // explicitly unknown/module receiver; call/bind cannot replace that capture.
  const receiverFor = (fn: Value, receiver?: Value): Value | undefined => ts.isArrowFunction(fn.node) ? fn.env.receiver : receiver;
  const explicitReceivers = (values: Value[] | undefined): Array<Value | undefined> => {
    if (!values) return [undefined];
    const container = collectionContainers.get(values);
    if (container) return [container];
    return values.length ? values : [undefined];
  };
  const bind = (fn: Value, args: Value[][], receiver?: Value): Environment => {
    const declaration = fn.node as ts.FunctionLikeDeclaration;
    const env: Environment = { id: nextEnvironment++, fn: declaration, closure: fn.env, parameters: new Map(), receiver: receiverFor(fn, receiver) };
    declaration.parameters.forEach((parameter, index) => {
      budget.take();
      if (parameter.dotDotDotToken) env.parameters.set(parameter, restValues(args, index, env));
      else if (parameter.initializer && takesDefault(args[index])) {
        budget.take((args[index]?.length ?? 0) + 1);
        const values: Value[] = [];
        // Undefined selects the initializer; it is not another possible value
        // of the initialized parameter. Preserve only supplied alternatives.
        for (const value of args[index] ?? []) if (!undefinedArgument(value)) values.push(value);
        values.push({ node: parameter.initializer, env });
        env.parameters.set(parameter, values);
      } else env.parameters.set(parameter, args[index] ?? []);
    });
    return env;
  };
  const valueKey = (value: Value): string => `${id(value.node)}:${callable(value.node) || ts.isObjectLiteralExpression(value.node) || ts.isArrayLiteralExpression(value.node) || ts.isNewExpression(value.node) || ts.isClassDeclaration(value.node) || ts.isClassExpression(value.node) ? value.env.id : 0}:${value.bound?.id ?? 0}:${value.memberReceiver ? id(value.memberReceiver.node) + ":" + value.memberReceiver.env.id : ""}:${value.fieldOwner?.id ?? 0}`;
  // Resolved parameter values are shared between call sites. Serializing a
  // wide value set at every invocation makes even cache hits quadratic.
  // Intern signatures once per array version, charging every uncached member.
  const valueSignatures = new WeakMap<Value[], { length: number; runtimeLength: number; signature: number }>();
  const signatureIds = new Map<string, number>();
  const valueSignature = (values: Value[]): number => {
    const cached = valueSignatures.get(values);
    const runtime = runtimeUnions.get(values)?.values;
    if (cached?.length === values.length && cached.runtimeLength === (runtime?.length ?? 0)) return cached.signature;
    const parts: string[] = [];
    for (const value of values) { budget.take(); parts.push(valueKey(value)); }
    const container = collectionContainers.get(values);
    const runtimeParts: string[] = [];
    if (runtime) for (const value of runtime) { budget.take(); runtimeParts.push(valueKey(value)); }
    const key = `${container ? valueKey(container) : ""}|${parts.join(",")}|${runtimeParts.join(",")}`;
    let signature = signatureIds.get(key);
    if (signature === undefined) { signature = signatureIds.size + 1; signatureIds.set(key, signature); }
    valueSignatures.set(values, { length: values.length, runtimeLength: runtime?.length ?? 0, signature });
    return signature;
  };
  const argumentSignature = (args: Value[][]): string => {
    const parts: number[] = [];
    for (const values of args) { budget.take(); parts.push(valueSignature(values)); }
    return parts.join(";");
  };
  const valueSets = new WeakMap<Value[], Set<string>>();
  const append = (target: Value[], values: readonly Value[]): void => {
    if (target === values) return;
    const container = collectionContainers.get(values as Value[]);
    const incoming = container ? [container] : runtimeUnions.get(values as Value[])?.values;
    let runtime = runtimeUnions.get(target);
    if (!runtime && incoming) {
      runtime = { values: [], keys: new Set() };
      for (const value of target) { budget.take(); const key = valueKey(value); if (!runtime.keys.has(key)) { runtime.keys.add(key); runtime.values.push(value); } }
      runtimeUnions.set(target, runtime);
    }
    if (runtime) for (const value of incoming ?? values) {
      budget.take(); const key = valueKey(value);
      if (!runtime.keys.has(key)) { runtime.keys.add(key); runtime.values.push(value); }
    }
    let known = valueSets.get(target);
    if (!known) { known = new Set(); for (const value of target) { budget.take(); known.add(valueKey(value)); } valueSets.set(target, known); }
    for (const value of values) { budget.take(); const key = valueKey(value); if (!known.has(key)) { known.add(key); target.push(value); } }
  };
  const memberValues = (values: Value[], receiver: Value): Value[] => {
    const member = (value: Value): Value => { budget.take(); return callable(value.node) ? { ...value, memberReceiver: receiver } : value; };
    const result = values.map(member);
    const container = collectionContainers.get(values);
    if (container) collectionContainers.set(result, container);
    else {
      const runtime = runtimeUnions.get(values);
      if (runtime) {
        const mapped: Value[] = [], keys = new Set<string>();
        for (const value of runtime.values) { const current = member(value); mapped.push(current); keys.add(valueKey(current)); }
        runtimeUnions.set(result, { values: mapped, keys });
      }
    }
    return result;
  };
  // Resolved value unions are append-only. Reusing a union must also reuse its
  // callable projection, rather than performing an uncharged linear filter at
  // every call site. Charge each newly observed member before inspecting it.
  const callableProjections = new WeakMap<Value[], { length: number; values: Value[] }>();
  const callables = (values: Value[]): Value[] => {
    let projection = callableProjections.get(values);
    if (!projection || projection.length > values.length) projection = { length: 0, values: [] };
    for (let index = projection.length; index < values.length; index++) {
      budget.take();
      if (callable(values[index].node)) projection.values.push(values[index]);
    }
    projection.length = values.length;
    callableProjections.set(values, projection);
    return projection.values;
  };
  const invoke = (fn: Value, args: Value[][], request?: boolean, receiver?: Value, plan?: ConstructorPlan, deferred = false): void => {
    const previousInitializations = deferred ? new Map(activeInitializations) : undefined;
    if (deferred) { budget.take(activeInitializations.size); activeInitializations.clear(); }
    try {
    if (!callable(fn.node) || request === undefined && !registrationCandidates.has(fn.node)) return;
    if (fn.bound) { budget.take(fn.bound.args.length + args.length); args = [...fn.bound.args, ...args]; receiver = fn.bound.receiver; }
    receiver = receiverFor(fn, receiver);
    const key = `${request === undefined ? "setup" : request ? "request" : "possible"}:${valueKey(fn)}:${receiver ? valueKey(receiver) : ""}:${argumentSignature(args)}:${plan?.id ?? 0}:${initializationSignature()}`;
    budget.take(); if (invoked.has(key)) return; invoked.add(key);
    const env = bind(fn, args, receiver);
    if (plan) constructorInvocations.set(env, plan);
    // Generator calls initialize formal parameters immediately, while their
    // bodies remain deferred until iteration (including async generators).
    if (fn.node.asteriskToken) { defaultExits(fn.node, args, env, 0, request, true); return; }
    scheduleInvocation(fn, args, env, request);
    } finally {
      if (previousInitializations) for (const [owner, state] of previousInitializations) { budget.take(); activeInitializations.set(owner, state); }
    }
  };
  const commonJsDefault = (call: ts.CallExpression, env: Environment, seen: Set<ts.Node>): ts.Expression | undefined => {
    if (!ts.isIdentifier(call.expression) || call.expression.text !== "require" || symbolOf(call.expression)?.declarations?.length) return undefined;
    const specifier = call.arguments[0];
    if (!specifier || !ts.isStringLiteralLike(specifier)) return undefined;
    const project = projectFor(call.getSourceFile());
    const rel = project?.resolve(call.getSourceFile().fileName, specifier.text);
    const source = rel && project?.sources.get(rel);
    if (!source) return undefined;
    if (commonJsDefaults.has(source)) return commonJsDefaults.get(source);
    let value: ts.Expression | undefined, position = -1, uncertain = false;
    const pending: ts.Node[] = [source];
    while (pending.length) {
      budget.take(); const node = pending.pop()!;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        && ts.isPropertyAccessExpression(node.left) && node.left.name.text === "exports"
        && ts.isIdentifier(node.left.expression) && node.left.expression.text === "module" && !symbolOf(node.left.expression)?.declarations?.some(declaration => !ts.isBinaryExpression(declaration))) {
        if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isExpressionStatement(node.parent) || node.parent.parent !== source) uncertain = true;
        else if (node.pos > position) { position = node.pos; value = node.right; }
      }
      ts.forEachChild(node, child => { pending.push(child); });
    }
    // Conditional/runtime export replacement cannot certify the original
    // callback identity. Only definite top-level default assignments qualify.
    const result = uncertain ? undefined : value;
    commonJsDefaults.set(source, result);
    return result;
  };
  const resolve = (node: ts.Node | undefined, env: Environment, use: ts.Node = node!, seen = new Set<ts.Node>(), factories = false): Value[] => {
    if (!node) return [];
    if (seen.has(node)) { resolutionCycles++; return []; }
    budget.take();
    const facts = `${uncertainBindings.size}:${unsafeReceivers.size}:${unsafeCallables.size}:${mutatedCollections.size}:${mutatedCollectionGlobals.size}`;
    if (facts !== resolutionFacts) { resolutionFacts = facts; resolutionEpoch++; declarationValues = new WeakMap(); }
    if (seen.size > 128) throw new AnalysisLimitError("Request binding resolution depth limit exceeded");
    for (const frame of resolutionFrames) { budget.take(); frame.max = Math.max(frame.max, seen.size); frame.dependencies.add(node); }
    const next = new Set(seen).add(node);
    if (transparent(node)) return resolve(node.expression, env, use, next, factories);
    if (node.kind === ts.SyntaxKind.ThisKeyword) return thisValues(node, env, next, factories);
    if (ts.isIdentifier(node)) {
      if (node.text === "undefined" && !symbolOf(node)?.declarations?.length) return [{ node, env: empty }];
      const direct = symbolOf(node)?.valueDeclaration;
      // A property alias must resolve the property access in its captured
      // receiver context; following its symbol straight to the field loses
      // the lexical this of an instance arrow initializer.
      const propertyAlias = direct && ts.isVariableDeclaration(direct) && direct.initializer
        && (ts.isPropertyAccessExpression(direct.initializer) || ts.isElementAccessExpression(direct.initializer));
      const declaration = propertyAlias ? direct : definitionOf(node) ?? direct;
      if (!declaration || declaration === node || uncertainBindings.has(declaration)) return [];
      return resolve(declaration, lexical(declaration, env), use, next, factories);
    }
    if (ts.isParameter(node) || ts.isBindingElement(node)) {
      for (let current: Environment | undefined = env; current; current = current.closure) {
        budget.take(); if (current.parameters.has(node)) return current.parameters.get(node)!;
      }
      return [];
    }
    if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) {
      if (uncertainBindings.has(node)) return [];
      const selected = replacement(node, use);
      if (selected === undefined && (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) && unsafeReceivers.has(node.parent)) return [];
      if (selected === null) return [];
      const owner = lexical(node, env);
      // Immutable declarations always resolve their captured initializer at
      // the same source position. Cache epochs follow indexed mutation facts;
      // incoming call-site positions cannot change this captured identity.
      const cacheable = stableResolutionPhase && !writes.has(writeDeclaration(node));
      const contextKey = `${owner.id}:${factories ? 1 : 0}`;
      const contexts = cacheable ? declarationValues.get(node) ?? new Map<string, DeclarationResolution>() : undefined;
      const known = contexts?.get(contextKey);
      if (known) {
        if (seen.size + known.height > 128) throw new AnalysisLimitError("Request binding resolution depth limit exceeded");
        let intersects = false;
        for (const ancestor of seen) { budget.take(); if (known.dependencies.has(ancestor)) { intersects = true; break; } }
        if (!intersects) {
          for (const frame of resolutionFrames) {
            budget.take(); frame.max = Math.max(frame.max, seen.size + known.height);
            for (const dependency of known.dependencies) { budget.take(); frame.dependencies.add(dependency); }
          }
          return known.values;
        }
      }
      const cycles = resolutionCycles;
      const epoch = resolutionEpoch;
      const frame = { start: seen.size, max: seen.size, dependencies: new Set<ts.Node>([node]) };
      if (contexts) resolutionFrames.push(frame);
      try {
        const values = resolve(selected ?? node.initializer, owner, selected ?? node.initializer ?? use, next, factories);
        if (contexts && cycles === resolutionCycles && epoch === resolutionEpoch) { contexts.set(contextKey, { values, height: frame.max - frame.start, dependencies: frame.dependencies }); declarationValues.set(node, contexts); }
        return values;
      } finally { if (contexts) resolutionFrames.pop(); }
    }
    if (ts.isShorthandPropertyAssignment(node)) return resolve(node.name, env, use, next, factories);
    if (ts.isExportAssignment(node)) return resolve(node.expression, env, use, next, factories);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node) ? node.name.text : propertyName(node.argumentExpression);
      const values: Value[] = [];
      for (const object of resolve(node.expression, env, node.expression, next, factories)) {
        budget.take();
        const owners = ts.isNewExpression(object.node) ? instanceValues(object, next, factories) : [object];
        for (const selected of owners) {
          budget.take(); const owner = selected.node;
          const rest = ts.isArrayLiteralExpression(owner) && restArrays.get(owner);
          if (rest && key !== undefined && (key === "length" || /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 2 ** 32 - 1)) {
            // Synthetic rest arrays carry already-evaluated arguments with
            // their original environments; their AST element list is empty.
            if (key === "length") {
              if (rest.spread === Infinity) append(values, [{ node: ts.factory.createNumericLiteral(rest.items.length), env: empty }]);
            } else {
              const index = Number(key);
              if (index < rest.spread) append(values, index < rest.items.length ? payloadValues(rest.items[index]) : [undefinedValue]);
            }
            continue;
          }
          const initializedField = key === undefined ? undefined : replacementField(selected, key, use, next, factories);
          if (initializedField !== undefined) append(values, initializedField);
          else if (key !== undefined && ts.isObjectLiteralExpression(owner)) append(values, memberValues(resolve(members(owner).get(key), selected.env, use, next, factories), selected));
          else {
          const declarationValue = ts.isNewExpression(owner) ? resolve(owner.expression, selected.env, owner.expression, next, factories)[0] : selected;
          const declaration = declarationValue?.node;
          if (key !== undefined && declaration && (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration))) {
            let ownerScope: Environment | undefined = env;
            while (ownerScope && (!ownerScope.fn || ts.isArrowFunction(ownerScope.fn))) { budget.take(); ownerScope = ownerScope.closure; }
            const method = ownerScope?.fn;
            const instanceMethod = method && method.parent === declaration && !ts.getModifiers(method)?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword);
            const instance = ts.isNewExpression(owner) || node.expression.kind === ts.SyntaxKind.ThisKeyword && !!instanceMethod;
            const member = selectedClassMember(declaration, key, instance, selected);
            if (member) {
              if (ts.isPropertyDeclaration(member) && !member.initializer) append(values, [undefinedValue]);
              else
              if (ts.isPropertyDeclaration(member) && member.initializer && ts.isArrowFunction(member.initializer) && !unsafeReceivers.has(declaration) && replacement(member, use) === undefined) {
                const contexts = fieldEnvironments.get(member) ?? new Map<string, Environment>();
                const contextKey = `${valueKey(selected)}:${declarationValue ? valueKey(declarationValue) : ""}`;
                let captured = contexts.get(contextKey);
                if (!captured) { captured = { id: nextEnvironment++, closure: declarationValue?.env ?? selected.env, parameters: new Map(), receiver: selected }; contexts.set(contextKey, captured); fieldEnvironments.set(member, contexts); }
                append(values, [{ node: member.initializer, env: captured, memberReceiver: selected }]);
              } else append(values, memberValues(resolve(member, declarationValue?.env ?? selected.env, use, next, factories), selected));
            }
            if (instance && !member) append(values, inheritedMemberValues(declaration, declarationValue?.env ?? selected.env, selected, key, use, next, factories));
          }
          }
        }
      }
      if (values.length) return values;
      const declaration = definitionOf(node);
      if (declaration && (ts.isMethodDeclaration(declaration) || ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration))) return [];
      return declaration && declaration !== node ? resolve(declaration, env, use, next, factories) : [];
    }
    if (ts.isArrayLiteralExpression(node)) {
      // Primitive literal arrays have no binding dependencies or mutable
      // initializer effects. Reuse their callback-list representation while
      // retaining the binding depth that visiting an element would consume.
      if (inertArray(node)) {
        if (node.elements.length && seen.size + 1 > 128) throw new AnalysisLimitError("Request binding resolution depth limit exceeded");
        for (const frame of resolutionFrames) { budget.take(); frame.max = Math.max(frame.max, seen.size + (node.elements.length ? 1 : 0)); }
        const contexts = literalArrayValues.get(node) ?? new Map<Environment, Value[]>();
        const cached = contexts.get(env); if (cached) return cached;
        let template = literalArrayTemplates.get(node);
        if (!template) {
          template = [];
          for (const element of node.elements) { budget.take(); append(template, resolve(element, env, element, next, factories)); }
          literalArrayTemplates.set(node, template);
        }
        // Preserve allocation/capture identity per environment; only the
        // immutable primitive element representation is shared.
        budget.take(template.length); const values = template.slice();
        collectionContainers.set(values, { node, env }); contexts.set(env, values); literalArrayValues.set(node, contexts); return values;
      }
      const values: Value[] = [];
      for (const element of node.elements) { budget.take(); append(values, resolve(ts.isSpreadElement(element) ? element.expression : element, env, element, next, factories)); }
      collectionContainers.set(values, { node, env });
      return values;
    }
    if (ts.isConditionalExpression(node)) {
      const condition = truth(node.condition, env, next, factories);
      if (condition !== undefined) return resolve(condition ? node.whenTrue : node.whenFalse, env, use, next, factories);
      const values: Value[] = []; append(values, resolve(node.whenTrue, env, use, next, factories)); append(values, resolve(node.whenFalse, env, use, next, factories)); return values;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) return resolve(node.right, env, use, next, factories);
    if (ts.isCallExpression(node)) {
      if ((ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))
        && (ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : propertyName(node.expression.argumentExpression)) === "bind") {
        const mode = `${env.id}:${factories ? 1 : 0}`;
        const known = reuseBinding(boundValues.get(node)?.get(mode), seen);
        if (known) return known;
        const frame = startBinding(seen.size, node), epoch = resolutionEpoch, cycles = resolutionCycles;
        try {
          const targets = nativeCallableMember(node.expression, env, next, factories);
          if (targets.length) {
            const receivers = explicitReceivers(resolve(node.arguments[0], env, node.arguments[0], next, factories));
            const args = node.arguments.slice(1).map(argument => resolve(argument, env, argument, next, factories));
            const values: Value[] = [];
            for (const target of targets) for (const receiver of target.bound ? [target.bound.receiver] : receivers) {
              budget.take(); budget.take((target.bound?.args.length ?? 0) + args.length);
              values.push({ node: target.node, env: target.env, bound: { id: nextBound++, receiver, args: [...(target.bound?.args ?? []), ...args] } });
            }
            if (epoch === resolutionEpoch && cycles === resolutionCycles) {
              const contexts = boundValues.get(node) ?? new Map<string, BindingSummary>();
              contexts.set(mode, bindingSummary(values, frame, epoch)); boundValues.set(node, contexts);
            }
            return values;
          }
        } finally { resolutionFrames.pop(); }
      }
      const exported = commonJsDefault(node, env, next);
      if (exported) return resolve(exported, empty, exported, next, factories);
      if (!factories) return [{ node, env }];
      const values: Value[] = [];
      for (const fn of resolve(node.expression, env, node.expression, next, factories)) if (callable(fn.node) && !fn.node.asteriskToken && !fn.node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
        let args = node.arguments.map(argument => resolve(argument, env, argument, next, factories));
        let receiver = (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) ? fn.memberReceiver ?? receiverOf(node.expression, env, next, factories) : receiverOf(node.expression, env, next, factories);
        if (fn.bound) { budget.take(fn.bound.args.length + args.length); args = [...fn.bound.args, ...args]; receiver = fn.bound.receiver; }
        receiver = receiverFor(fn, receiver);
        const key = `${valueKey(fn)}:${receiver ? valueKey(receiver) : ""}:${argumentSignature(args)}:${initializationSignature()}`;
        const known = reuseBinding(factoryResults.get(key), seen);
        if (known) { append(values, known); continue; }
        if (activeFactories.has(key)) { resolutionCycles++; continue; }
        const returned: Value[] = [];
        // An in-progress factory cycle has unknown returned identity. Publish
        // completed values only; a work-limit failure cannot cache a prefix.
        activeFactories.add(key);
        const frame = startBinding(seen.size, node), epoch = resolutionEpoch, cycles = resolutionCycles;
        try {
          const inner = bind(fn, args, receiver);
          if (!ts.isBlock(fn.node.body)) append(returned, resolve(fn.node.body, inner, fn.node.body, next, factories));
          else for (const current of statementFlow(fn.node.body, inner).returns) {
            budget.take(); append(returned, resolve(current.expression, inner, current.expression ?? current, next, factories));
          }
          if (epoch === resolutionEpoch && cycles === resolutionCycles) factoryResults.set(key, bindingSummary(returned, frame, epoch));
        } finally { resolutionFrames.pop(); activeFactories.delete(key); }
        append(values, returned);
      }
      return values.length || runtimeUnions.get(values)?.values.length ? values : [{ node, env }];
    }
    if (ts.isMethodDeclaration(node)) {
      const selected = replacement(node, use);
      if (selected !== undefined) return selected === null ? [] : resolve(selected, env, selected, next, factories);
      if (unsafeReceivers.has(node.parent)) return [];
    }
    return [{ node, env: lexical(node, env) }];
  };
  const literalValues = (node: ts.Expression, env: Environment, seen = new Set<ts.Node>(), factories = false): ts.Expression[] => {
    let value: ts.Expression = node;
    while (transparent(value)) { budget.take(); value = value.expression; }
    if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.CommaToken) return literalValues(value.right, env, seen, factories);
    if (ts.isIdentifier(value) && value.text === "undefined" && !symbolOf(value)?.declarations?.length) return [value];
    if (!ts.isIdentifier(value)) return [value];
    const values = resolve(value, env, value, seen, factories);
    const container = collectionContainers.get(values);
    if (container && ts.isExpression(container.node)) return [container.node];
    const expressions: ts.Expression[] = [];
    for (const resolved of values) {
      budget.take(); if (!ts.isExpression(resolved.node)) return [];
      expressions.push(resolved.node);
    }
    return expressions;
  };
  const literal = (node: ts.Expression, env: Environment, seen = new Set<ts.Node>(), factories = false): ts.Expression | undefined => {
    let result: ts.Expression | undefined, key: string | undefined;
    for (const value of literalValues(node, env, seen, factories)) {
      budget.take();
      const current = ts.isStringLiteralLike(value) ? `string:${value.text}` : ts.isNumericLiteral(value) ? `number:${Number(value.text)}`
        : [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(value.kind) ? `kind:${value.kind}`
        : ts.isVoidExpression(value) || ts.isIdentifier(value) && value.text === "undefined" && !symbolOf(value)?.declarations?.length ? "undefined" : `node:${id(value)}`;
      if (key !== undefined && key !== current) return undefined;
      key = current; result = value;
    }
    return result;
  };
  const nullish = (node: ts.Expression, env: Environment, seen = new Set<ts.Node>(), factories = false): boolean | undefined => {
    let result: boolean | undefined;
    for (const value of literalValues(node, env, seen, factories)) {
      budget.take();
      const selected = value.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(value)
        || ts.isIdentifier(value) && value.text === "undefined" && !symbolOf(value)?.declarations?.length ? true
        : ts.isStringLiteralLike(value) || ts.isNumericLiteral(value) || ts.isArrayLiteralExpression(value)
          || ts.isObjectLiteralExpression(value) || ts.isFunctionExpression(value) || ts.isArrowFunction(value)
          || value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword ? false : undefined;
      if (selected === undefined || result !== undefined && result !== selected) return undefined;
      result = selected;
    }
    return result;
  };
  const truth = (node: ts.Expression, env: Environment, seen = new Set<ts.Node>(), factories = false): boolean | undefined => {
    let result: boolean | undefined;
    for (const value of literalValues(node, env, seen, factories)) {
      budget.take();
      const selected = value.kind === ts.SyntaxKind.TrueKeyword ? true
        : value.kind === ts.SyntaxKind.FalseKeyword || value.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(value)
          || ts.isIdentifier(value) && value.text === "undefined" && !symbolOf(value)?.declarations?.length ? false
        : ts.isStringLiteralLike(value) ? value.text.length > 0 : ts.isNumericLiteral(value) ? Number(value.text) !== 0
        : ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value) || ts.isFunctionExpression(value) || ts.isArrowFunction(value) ? true : undefined;
      if (selected === undefined || result !== undefined && result !== selected) return undefined;
      result = selected;
    }
    return result;
  };
  const NORMAL = 1, RETURN = 2, THROW = 4, BREAK = 8, CONTINUE = 16;
  interface StatementFlow { exits: number; returns: ts.ReturnStatement[]; statements?: readonly ts.Node[] }
  interface CompletionSummary<T> { value: T; height: number }
  interface CompletionFrame { start: number; max: number }
  const completionFrames: CompletionFrame[] = [];
  const completionDepth = (depth: number): void => {
    if (depth > 128) throw new AnalysisLimitError("Request binding resolution depth limit exceeded");
    const frame = completionFrames.at(-1);
    if (frame) frame.max = Math.max(frame.max, depth);
  };
  const startCompletion = (depth: number): CompletionFrame => {
    const frame = { start: depth, max: depth }; completionFrames.push(frame); return frame;
  };
  const finishCompletion = (frame: CompletionFrame): void => {
    completionFrames.pop();
    const parent = completionFrames.at(-1);
    if (parent) parent.max = Math.max(parent.max, frame.max);
  };
  const completionSummary = <T>(value: T, frame: CompletionFrame): CompletionSummary<T> => ({ value, height: frame.max - frame.start });
  const reuseCompletion = <T>(summary: CompletionSummary<T>, depth: number): T => {
    completionDepth(depth + summary.height); return summary.value;
  };
  const statementFlows = new WeakMap<ts.Node, Map<number, CompletionSummary<StatementFlow>>>();
  const activeCompletions = new Set<ts.Node>();
  const completionResults = new Map<string, CompletionSummary<number>>();
  const nonCallableTargets = new WeakMap<Value[], { length: number; known: boolean }>();
  const definitelyNonCallable = (values: Value[]): boolean => {
    if (!values.length) return false;
    let result = nonCallableTargets.get(values);
    if (!result || result.length > values.length) result = { length: 0, known: true };
    for (let index = result.length; result.known && index < values.length; index++) {
      budget.take(); const node = values[index].node;
      result.known = ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)
        || ts.isNumericLiteral(node) || ts.isStringLiteralLike(node) || ts.isBigIntLiteral(node)
        || ts.isClassDeclaration(node) || ts.isClassExpression(node) || isUndefinedValue(values[index])
        || [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.kind);
    }
    result.length = values.length; nonCallableTargets.set(values, result);
    return result.known;
  };
  // Only these expression children execute while constructing a value. Method
  // bodies remain deferred, but their computed keys execute immediately.
  const valueExpressionChildren = (node: ts.Node): ts.Expression[] | undefined => {
    if (ts.isArrayLiteralExpression(node)) {
      const values: ts.Expression[] = [];
      for (const element of node.elements) { budget.take(); if (!ts.isOmittedExpression(element)) values.push(ts.isSpreadElement(element) ? element.expression : element); }
      return values;
    }
    if (ts.isObjectLiteralExpression(node)) {
      const values: ts.Expression[] = [];
      for (const property of node.properties) {
        budget.take();
        if (property.name && ts.isComputedPropertyName(property.name)) values.push(property.name.expression);
        if (ts.isPropertyAssignment(property)) values.push(property.initializer);
        else if (ts.isShorthandPropertyAssignment(property)) values.push(property.name);
        else if (ts.isSpreadAssignment(property)) values.push(property.expression);
      }
      return values;
    }
    if (ts.isTemplateExpression(node)) {
      const values: ts.Expression[] = [];
      for (const span of node.templateSpans) { budget.take(); values.push(span.expression); }
      return values;
    }
    return undefined;
  };
  const firstSuspensions = new WeakMap<ts.FunctionLikeDeclaration, number>();
  const syntaxTruth = (expression: ts.Expression): boolean | undefined => {
    budget.take();
    while (transparent(expression)) { budget.take(); expression = expression.expression; }
    if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (expression.kind === ts.SyntaxKind.FalseKeyword || expression.kind === ts.SyntaxKind.NullKeyword) return false;
    if (ts.isNumericLiteral(expression)) return Number(expression.text) !== 0;
    if (ts.isStringLiteralLike(expression)) return expression.text.length > 0;
    return undefined;
  };
  const afterPossibleSuspension = (node: ts.Node): boolean => {
    const fn = enclosing(node);
    if (!fn?.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) || !callable(fn)) return false;
    let end = firstSuspensions.get(fn);
    if (end === undefined) {
      end = Infinity;
      const pending: ts.Node[] = [fn.body];
      while (pending.length) {
        budget.take(); const current = pending.pop()!;
        if (ts.isFunctionLike(current) || ts.isClassDeclaration(current) || ts.isClassExpression(current)) continue;
        // Only literal guard pruning is needed here. Unknown guards retain
        // their possible suspension; parameter values must not be borrowed
        // from a different invocation when caching this syntax fact.
        if (ts.isIfStatement(current) || ts.isConditionalExpression(current)) {
          const condition = ts.isIfStatement(current) ? current.expression : current.condition;
          const selected = syntaxTruth(condition);
          pending.push(condition);
          if (selected !== false) pending.push(ts.isIfStatement(current) ? current.thenStatement : current.whenTrue);
          const other = ts.isIfStatement(current) ? current.elseStatement : current.whenFalse;
          if (selected !== true && other) pending.push(other);
          continue;
        }
        if (ts.isWhileStatement(current) && syntaxTruth(current.expression) === false) { pending.push(current.expression); continue; }
        if (ts.isForStatement(current) && current.condition && syntaxTruth(current.condition) === false) { if (current.initializer) pending.push(current.initializer); pending.push(current.condition); continue; }
        if (ts.isBinaryExpression(current)) {
          if (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && syntaxTruth(current.left) === false
            || current.operatorToken.kind === ts.SyntaxKind.BarBarToken && syntaxTruth(current.left) === true) { pending.push(current.left); continue; }
        }
        if (ts.isAwaitExpression(current)) end = Math.min(end, current.end);
        ts.forEachChild(current, child => { pending.push(child); });
      }
      firstSuspensions.set(fn, end);
    }
    return node.pos >= end;
  };
  const expressionExits = (node: ts.Expression | undefined, env: Environment, depth = 0): number => {
    budget.take();
    if (!node) return NORMAL;
    completionDepth(depth);
    if ((activeInitializations.size || failedInitializationCount) && ts.isIdentifier(node)) {
      const declaration = symbolOf(node)?.valueDeclaration;
      if (declaration && (ts.isParameter(declaration) || ts.isBindingElement(declaration))) {
        const owner = lexical(declaration, env);
        const completed = completedInitializations.get(owner);
        const suspended = afterPossibleSuspension(node);
        const state = suspended ? completed && !(completed.exits & NORMAL) ? completed.state : undefined
          : activeInitializations.get(owner) ?? (completed && !(completed.exits & NORMAL) ? completed.state : undefined);
        const position = state?.order.get(declaration);
        if (position !== undefined && position >= state!.cursor) return THROW;
      }
    }
    if (transparent(node)) return expressionExits(node.expression, env, depth + 1);
    if (ts.isAwaitExpression(node)) return expressionExits(node.expression, env, depth + 1) | THROW;
    if (ts.isVoidExpression(node) || ts.isTypeOfExpression(node) || ts.isDeleteExpression(node) || ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      return expressionExits(ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node) ? node.operand : node.expression, env, depth + 1);
    }
    if (ts.isArrayLiteralExpression(node) && inertArray(node)) {
      if (node.elements.length) completionDepth(depth + 1);
      return NORMAL;
    }
    const values = valueExpressionChildren(node);
    if (values) {
      let exits = NORMAL;
      for (const value of values) {
        budget.take(); if (!(exits & NORMAL)) break;
        exits = (exits & THROW) | expressionExits(value, env, depth + 1);
      }
      return exits;
    }
    let optionalNormal = 0;
    let optional: ts.Node = node;
    while (ts.isCallExpression(optional) || ts.isPropertyAccessExpression(optional) || ts.isElementAccessExpression(optional)) {
      budget.take();
      if (optional.questionDotToken) {
        const selected = nullish(optional.expression, env);
        const receiver = expressionExits(optional.expression, env, depth + 1);
        if (!(receiver & NORMAL)) return receiver;
        if (selected === true) return receiver;
        if (selected === undefined) optionalNormal = NORMAL;
      }
      optional = optional.expression;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const receiver = expressionExits(node.expression, env, depth + 1);
      if (!(receiver & NORMAL)) return receiver | optionalNormal;
      return (receiver & THROW) | (ts.isElementAccessExpression(node) ? expressionExits(node.argumentExpression, env, depth + 1) : NORMAL) | optionalNormal;
    }
    if (ts.isConditionalExpression(node)) {
      const condition = expressionExits(node.condition, env, depth + 1);
      if (!(condition & NORMAL)) return condition;
      const selected = truth(node.condition, env);
      return (condition & THROW) | (selected === false ? 0 : expressionExits(node.whenTrue, env, depth + 1)) | (selected === true ? 0 : expressionExits(node.whenFalse, env, depth + 1));
    }
    if (ts.isBinaryExpression(node)) {
      const left = expressionExits(node.left, env, depth + 1);
      if (!(left & NORMAL)) return left;
      const selected = truth(node.left, env);
      const skipped = node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? selected === false
        : node.operatorToken.kind === ts.SyntaxKind.BarBarToken ? selected === true
        : node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ? nullish(node.left, env) === false : false;
      if (skipped) return left;
      const optional = [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind) && selected === undefined;
      return (left & THROW) | (optional ? NORMAL : 0) | expressionExits(node.right, env, depth + 1);
    }
    if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return NORMAL;
    let prefix = expressionExits(node.expression, env, depth + 1);
    if (!(prefix & NORMAL)) return prefix;
    for (const argument of node.arguments ?? []) {
      budget.take(); const exits = expressionExits(ts.isSpreadElement(argument) ? argument.expression : argument, env, depth + 1);
      prefix = (prefix & THROW) | exits; if (!(exits & NORMAL)) return prefix | optionalNormal;
    }
    const resolvedTargets = resolve(node.expression, env);
    let functions = callables(resolvedTargets);
    let args = (node.arguments ?? []).map(argument => resolve(argument, env));
    let receiver = receiverOf(node.expression, env);
    let receiverAlternatives: Array<Value | undefined> | undefined;
    if (ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
      const method = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : propertyName(node.expression.argumentExpression);
      if (method === "call") { functions = nativeCallableMember(node.expression, env); receiverAlternatives = explicitReceivers(args[0]); args = args.slice(1); }
      if (method === "bind" && nativeCallableMember(node.expression, env).length) return prefix;
    }
    let construction = 0, hasConstruction = false;
    if (ts.isNewExpression(node)) for (const value of resolve(node.expression, env)) {
      budget.take();
      if (!ts.isClassDeclaration(value.node) && !ts.isClassExpression(value.node)) continue;
      hasConstruction = true;
      construction |= constructorExits(value, args, { node, env }, depth + 1);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
      for (let scope: Environment | undefined = env; scope; scope = scope.closure) {
        budget.take(); if (!scope.fn || !ts.isConstructorDeclaration(scope.fn)) continue;
        hasConstruction = true;
        for (const heritage of scope.fn.parent.heritageClauses ?? []) if (heritage.token === ts.SyntaxKind.ExtendsKeyword) for (const type of heritage.types) for (const parent of resolve(type.expression, scope)) {
          budget.take();
          construction |= constructorExits(parent, args, scope.receiver, depth + 1);
        }
        if (construction & NORMAL) construction = (construction & THROW) | fieldExits(scope.fn.parent, scope, depth + 1);
        break;
      }
    }
    if (hasConstruction) return (prefix & THROW) | construction | optionalNormal;
    const reduced = ts.isCallExpression(node) ? reductionCompletion(node, env, args, depth + 1) : undefined;
    if (reduced !== undefined) return (prefix & THROW) | reduced | optionalNormal;
    if (!functions.length) return (definitelyNonCallable(resolvedTargets) || uninstalledFieldCall(node.expression, env, resolvedTargets) ? prefix & THROW : prefix) | THROW | optionalNormal;
    let exits = prefix & THROW;
    for (const fn of functions) for (const selectedReceiver of receiverAlternatives ?? [receiver]) {
      budget.take();
      if (!callable(fn.node) || !fn.node.asteriskToken && fn.node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) || activeCompletions.has(fn.node)) { exits |= NORMAL | THROW; continue; }
      let supplied = args, target = !receiverAlternatives && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) ? fn.memberReceiver ?? selectedReceiver : selectedReceiver;
      if (fn.bound) { budget.take(fn.bound.args.length + args.length); supplied = [...fn.bound.args, ...args]; target = fn.bound.receiver; }
      const completionKey = `${valueKey(fn)}:${target ? valueKey(target) : ""}:${argumentSignature(supplied)}:${initializationSignature()}`;
      const known = completionResults.get(completionKey);
      if (known !== undefined) { exits |= reuseCompletion(known, depth); continue; }
      activeCompletions.add(fn.node);
      const frame = startCompletion(depth);
      try {
        const inner = bind(fn, supplied, target);
        const entry = defaultExits(fn.node, supplied, inner, depth + 1);
        const body = entry & NORMAL ? fn.node.asteriskToken ? NORMAL : ts.isBlock(fn.node.body) ? statementFlow(fn.node.body, inner, depth + 1).exits : expressionExits(fn.node.body, inner, depth + 1) : 0;
        const result = (entry & THROW) | body;
        const completed = (result & (NORMAL | RETURN) ? NORMAL : 0) | (result & THROW);
        completionResults.set(completionKey, completionSummary(completed, frame)); exits |= completed;
      } finally { finishCompletion(frame); activeCompletions.delete(fn.node); }
    }
    return exits | optionalNormal;
  };
  const returnUnion = (left: readonly ts.ReturnStatement[], right: readonly ts.ReturnStatement[]): ts.ReturnStatement[] => {
    const combined: ts.ReturnStatement[] = [];
    for (const values of [left, right]) for (const value of values) { budget.take(); combined.push(value); }
    return combined;
  };
  const mayThrow = (root: ts.Node, env: Environment): boolean => {
    const pending: ts.Node[] = [root];
    while (pending.length) {
      budget.take(); const node = pending.pop()!;
      if (ts.isFunctionLike(node)) continue;
      if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isAwaitExpression(node)
        || ts.isTaggedTemplateExpression(node) || ts.isThrowStatement(node)
        || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
        || ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isBinaryExpression(node)) return true;
      if (ts.isIdentifier(node) && node.text !== "undefined" && !symbolOf(node)?.declarations?.length) return true;
      if (ts.isBlock(node)) {
        for (const statement of statementFlow(node, env).statements ?? []) { budget.take(); pending.push(statement); }
      } else if (ts.isIfStatement(node)) {
        pending.push(node.expression);
        const selected = truth(node.expression, env);
        if (selected !== false) pending.push(node.thenStatement);
        if (selected !== true && node.elseStatement) pending.push(node.elseStatement);
      } else ts.forEachChild(node, child => { pending.push(child); });
    }
    return false;
  };
  // Completion is separate from expression traversal: a return in one possible
  // branch must not suppress its sibling, but a definitely completed block must
  // not manufacture request evidence from its unreachable tail. Cache by bound
  // invocation because guards can depend on a helper's parameter values.
  const statementFlow = (node: ts.Node, env: Environment, depth = 0): StatementFlow => {
    budget.take();
    completionDepth(depth);
    let cache = statementFlows.get(node);
    const known = cache?.get(env.id); if (known) return reuseCompletion(known, depth);
    const frame = startCompletion(depth);
    try {
    const child = (value: ts.Node): StatementFlow => statementFlow(value, env, depth + 1);
    const union = (left: StatementFlow, right: StatementFlow): StatementFlow => ({ exits: left.exits | right.exits, returns: returnUnion(left.returns, right.returns) });
    let result: StatementFlow = { exits: NORMAL, returns: [] };
    if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      let exits = NORMAL;
      const returns: ts.ReturnStatement[] = [], statements: ts.Node[] = [];
      for (const statement of node.statements) {
        budget.take(); if (!(exits & NORMAL)) break;
        statements.push(statement);
        const next = child(statement);
        exits = (exits & ~NORMAL) | next.exits;
        for (const item of next.returns) { budget.take(); returns.push(item); }
      }
      result = { exits, returns, statements };
    } else if (ts.isExpressionStatement(node)) result = { exits: expressionExits(node.expression, env, depth + 1), returns: [] };
    else if (ts.isVariableStatement(node) || ts.isVariableDeclarationList(node)) {
      let exits = NORMAL;
      for (const declaration of (ts.isVariableStatement(node) ? node.declarationList : node).declarations) { budget.take(); if (!(exits & NORMAL)) break; exits = (exits & THROW) | expressionExits(declaration.initializer, env, depth + 1); }
      result = { exits, returns: [] };
    }
    else if (ts.isReturnStatement(node)) {
      const exits = expressionExits(node.expression, env, depth + 1);
      result = { exits: (exits & NORMAL ? RETURN : 0) | (exits & THROW), returns: exits & NORMAL ? [node] : [] };
    }
    else if (ts.isThrowStatement(node)) result = { exits: THROW, returns: [] };
    else if (ts.isBreakStatement(node)) result = { exits: BREAK, returns: [] };
    else if (ts.isContinueStatement(node)) result = { exits: CONTINUE, returns: [] };
    else if (ts.isSwitchStatement(node)) {
      const discriminant = expressionExits(node.expression, env, depth + 1);
      const statements: ts.Node[] = [node.expression];
      if (!(discriminant & NORMAL)) result = { exits: discriminant, returns: [], statements };
      else {
        const scalar = (expression: ts.Expression): string | undefined => {
          const value = literal(expression, env);
          if (!value) return undefined;
          if (ts.isStringLiteralLike(value)) return `string:${value.text}`;
          if (ts.isNumericLiteral(value)) return `number:${Number(value.text)}`;
          if ([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(value.kind)) return String(value.kind);
          return undefined;
        };
        const value = scalar(node.expression), starts = new Set<number>();
        let search = NORMAL, exits = discriminant & THROW, fallback = -1;
        // Case expressions execute in order only until a match. A possible
        // earlier match can still enter its body when a later case throws.
        for (let index = 0; index < node.caseBlock.clauses.length; index++) {
          budget.take(); const clause = node.caseBlock.clauses[index];
          if (ts.isDefaultClause(clause)) { fallback = index; continue; }
          if (!(search & NORMAL)) continue;
          statements.push(clause.expression);
          const evaluated = expressionExits(clause.expression, env, depth + 1);
          exits |= evaluated & THROW;
          if (!(evaluated & NORMAL)) { search = 0; continue; }
          const key = scalar(clause.expression);
          if (value === undefined || key === undefined || key === value) starts.add(index);
          if (value !== undefined && key === value) search = 0;
        }
        if (search & NORMAL) { if (fallback >= 0) starts.add(fallback); else exits |= NORMAL; }
        let active = false;
        const returns: ts.ReturnStatement[] = [];
        for (let index = 0; index < node.caseBlock.clauses.length; index++) {
          budget.take(); active = active || starts.has(index);
          if (!active) continue;
          const clause = node.caseBlock.clauses[index], next = child(clause);
          statements.push(clause); exits |= next.exits & ~NORMAL;
          for (const item of next.returns) { budget.take(); returns.push(item); }
          active = !!(next.exits & NORMAL);
        }
        if (active) exits |= NORMAL;
        result = { exits: (exits & ~BREAK) | (exits & BREAK ? NORMAL : 0), returns, statements };
      }
    }
    else if (ts.isIfStatement(node)) {
      const condition = expressionExits(node.expression, env, depth + 1);
      const selected = truth(node.expression, env);
      const yes = !(condition & NORMAL) || selected === false ? { exits: 0, returns: [] } : child(node.thenStatement);
      const no = !(condition & NORMAL) || selected === true ? { exits: 0, returns: [] } : node.elseStatement ? child(node.elseStatement) : { exits: NORMAL, returns: [] };
      result = union(yes, no); result.exits |= condition & THROW;
    } else if (ts.isTryStatement(node)) {
      const attempted = child(node.tryBlock);
      let completed = attempted;
      if (node.catchClause && (attempted.exits & THROW || mayThrow(node.tryBlock, env))) {
        // Calls may throw even without an explicit throw statement, so a catch
        // remains a potential path; it cannot erase normal/return completions.
        const caught = child(node.catchClause.block);
        completed = { exits: (attempted.exits & ~THROW) | caught.exits, returns: returnUnion(attempted.returns, caught.returns) };
      }
      if (node.finallyBlock) {
        const final = child(node.finallyBlock);
        result = { exits: (final.exits & NORMAL ? completed.exits : 0) | (final.exits & ~NORMAL), returns: final.exits & NORMAL ? returnUnion(completed.returns, final.returns) : final.returns };
      } else result = completed;
    } else if (ts.isWhileStatement(node) || ts.isForStatement(node) || ts.isDoStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      const condition = ts.isWhileStatement(node) || ts.isDoStatement(node) ? node.expression : ts.isForStatement(node) ? node.condition : undefined;
      let prefix = NORMAL;
      if (ts.isForStatement(node) && node.initializer) prefix = ts.isVariableDeclarationList(node.initializer) ? child(node.initializer).exits : expressionExits(node.initializer, env, depth + 1);
      if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && prefix & NORMAL) prefix = (prefix & THROW) | expressionExits(node.expression, env, depth + 1);
      if (!ts.isDoStatement(node) && condition && prefix & NORMAL) prefix = (prefix & THROW) | expressionExits(condition, env, depth + 1);
      const selected = condition ? truth(condition, env) : ts.isForStatement(node) ? true : undefined;
      if (!(prefix & NORMAL)) result = { exits: prefix, returns: [] };
      else if (selected === false && !ts.isDoStatement(node)) result = { exits: prefix, returns: [] };
      else {
        const body = child(node.statement);
        let repeat = body.exits & (NORMAL | CONTINUE) ? NORMAL : 0;
        if (repeat && ts.isForStatement(node) && node.incrementor) repeat = expressionExits(node.incrementor, env, depth + 1);
        if (repeat & NORMAL && ts.isDoStatement(node)) repeat = (repeat & THROW) | expressionExits(node.expression, env, depth + 1);
        const normal = !!(body.exits & BREAK) || (ts.isDoStatement(node) ? selected !== true && !!(repeat & NORMAL) : selected !== true);
        result = { exits: (prefix & THROW) | (normal ? NORMAL : 0) | (repeat & THROW) | (body.exits & (RETURN | THROW)), returns: body.returns };
      }
    } else if (ts.isLabeledStatement(node)) {
      const body = child(node.statement);
      result = { exits: (body.exits & ~BREAK) | (body.exits & BREAK ? NORMAL : 0), returns: body.returns };
    } else if (ts.isWithStatement(node)) result = child(node.statement);
    if (!cache) { cache = new Map(); statementFlows.set(node, cache); }
    cache.set(env.id, completionSummary(result, frame)); return result;
    } finally { finishCompletion(frame); }
  };
  const isUndefinedValue = (value: Value): boolean => ts.isVoidExpression(value.node) || ts.isIdentifier(value.node) && value.node.text === "undefined" && !symbolOf(value.node)?.declarations?.length;
  interface PatternInput { values: Value[]; uncertain: boolean }
  type DefaultEvaluator = (expression: ts.Expression, possible: boolean, depth: number) => number;
  // Parameter binding evaluates nested defaults in source order, before a
  // generator body can be resumed. Preserve runtime containers here: the
  // ordinary callback resolver intentionally exposes array elements instead.
  const patternValues = (values: Value[]): Value[] => {
    const container = collectionContainers.get(values);
    if (container) return [container];
    const actualValues = runtimeUnions.get(values)?.values ?? values;
    const result: Value[] = [];
    for (const value of actualValues) {
      budget.take();
      if (ts.isIdentifier(value.node) || transparent(value.node)) {
        const resolved = resolve(value.node, value.env);
        const actual = collectionContainers.get(resolved);
        append(result, actual ? [actual] : resolved.length ? resolved : [value]);
      } else append(result, [value]);
    }
    return result;
  };
  const unknownPattern = (node: ts.Node, env: Environment): PatternInput => ({ values: [{ node, env }], uncertain: true });
  const patternArraySpreads = new WeakMap<ts.ArrayLiteralExpression, number>();
  const patternObjectProperties = new WeakMap<ts.ObjectLiteralExpression, { writes: Map<string, { property: ts.ObjectLiteralElementLike; index: number }>; unknown: number }>();
  const patternStringElements = new WeakMap<ts.StringLiteralLike, ts.StringLiteral[]>();
  const firstPatternSpread = (node: ts.ArrayLiteralExpression): number => {
    let known = patternArraySpreads.get(node);
    if (known !== undefined) return known;
    known = Infinity;
    for (let index = 0; index < node.elements.length; index++) { budget.take(); if (ts.isSpreadElement(node.elements[index])) { known = index; break; } }
    patternArraySpreads.set(node, known); return known;
  };
  const patternObjectFacts = (node: ts.ObjectLiteralExpression): { writes: Map<string, { property: ts.ObjectLiteralElementLike; index: number }>; unknown: number } => {
    let known = patternObjectProperties.get(node); if (known) return known;
    known = { writes: new Map(), unknown: -1 };
    for (let index = 0; index < node.properties.length; index++) {
      budget.take(); const property = node.properties[index];
      if (ts.isSpreadAssignment(property) || !property.name || ts.isComputedPropertyName(property.name)) { known.unknown = index; continue; }
      const key = propertyName(property.name);
      if (key === undefined || key === "__proto__" && ts.isPropertyAssignment(property)) { known.unknown = index; continue; }
      known.writes.set(key, { property, index });
    }
    patternObjectProperties.set(node, known); return known;
  };
  const patternString = (node: ts.StringLiteralLike): ts.StringLiteral[] => {
    let known = patternStringElements.get(node); if (known) return known;
    known = [];
    // String iterators yield Unicode code points, not UTF-16 code units.
    for (const character of node.text) { budget.take(); known.push(ts.factory.createStringLiteral(character)); }
    patternStringElements.set(node, known); return known;
  };
  const patternProperty = (input: PatternInput, key: string | undefined, index: number | undefined, node: ts.Node, env: Environment): PatternInput => {
    const result: PatternInput = { values: [], uncertain: input.uncertain };
    const unknown = (): void => { result.uncertain = true; append(result.values, [{ node, env }]); };
    for (const value of input.values) {
      budget.take();
      const restValue = ts.isArrayLiteralExpression(value.node) && restArrays.get(value.node);
      if (index === undefined && restValue) {
        if (key === "length") {
          if (restValue.spread === Infinity) append(result.values, [{ node: ts.factory.createNumericLiteral(restValue.items.length), env: empty }]); else unknown();
        } else if (key !== undefined && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 2 ** 32 - 1) {
          const selected = patternProperty({ values: [value], uncertain: input.uncertain }, undefined, Number(key), node, env);
          append(result.values, selected.values); result.uncertain ||= selected.uncertain;
        } else if (key !== undefined && !["constructor", "__proto__", "toString", "valueOf", "map", "forEach", "filter", "reduce", "slice", "entries", "keys", "values"].includes(key)) append(result.values, [undefinedValue]);
        else unknown();
      } else if (index !== undefined) {
        const rest = ts.isArrayLiteralExpression(value.node) && restArrays.get(value.node);
        if (rest) {
          if (index >= rest.spread) unknown();
          else if (index >= rest.items.length) append(result.values, [undefinedValue]);
          else {
            const values = patternValues(rest.items[index]);
            if (values.length) append(result.values, values); else unknown();
          }
        } else if (ts.isArrayLiteralExpression(value.node) && !mutatedCollections.has(value.node) && !reshapedCollections.has(value.node)) {
          const selected = value.node.elements[index];
          if (firstPatternSpread(value.node) <= index) unknown();
          else if (!selected || ts.isOmittedExpression(selected)) append(result.values, [undefinedValue]);
          else { const values = patternValues(resolve(selected, value.env)); if (values.length) append(result.values, values); else unknown(); }
        } else if (ts.isStringLiteralLike(value.node)) {
          const characters = patternString(value.node);
          if (index >= characters.length) append(result.values, [undefinedValue]);
          else append(result.values, [{ node: characters[index], env: empty }]);
        } else if (ts.isExpression(value.node)) {
          const shape = arrayElements(value.node, value.env);
          if (shape) {
            // Compact Array(n) shapes contain only representative holes.
            const selected = shape.items[index];
            if (!selected || shape.holes[index]) append(result.values, [undefinedValue]);
            else append(result.values, selected);
          } else unknown();
        } else unknown();
      } else if (key !== undefined && ts.isObjectLiteralExpression(value.node) && !unsafeReceivers.has(value.node) && !mutatedCollections.has(value.node)) {
        const facts = patternObjectFacts(value.node), write = facts.writes.get(key);
        const uncertain = facts.unknown >= 0 && (!write || write.index < facts.unknown);
        const selected = uncertain ? undefined : write?.property;
        if (selected && ts.isPropertyAssignment(selected)) {
          const values = patternValues(resolve(selected, value.env, node)); if (values.length) append(result.values, values); else unknown();
        } else if (selected && ts.isShorthandPropertyAssignment(selected)) {
          const values = patternValues(resolve(selected.name, value.env)); if (values.length) append(result.values, values); else unknown();
        } else if (selected && ts.isMethodDeclaration(selected)) append(result.values, [{ node: selected, env: value.env }]);
        else if (selected || uncertain || mutatedCollectionGlobals.has("Object") || ["constructor", "__proto__", "toString", "toLocaleString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"].includes(key)) unknown();
        else append(result.values, [undefinedValue]);
      } else unknown();
    }
    return result;
  };
  const parameterOrders = new WeakMap<ts.FunctionLikeDeclaration, ReadonlyMap<ts.Declaration, number>>();
  const parameterOrder = (fn: ts.FunctionLikeDeclaration): ReadonlyMap<ts.Declaration, number> => {
    let known = parameterOrders.get(fn); if (known) return known;
    const order = new Map<ts.Declaration, number>();
    const pending: ts.Declaration[] = [];
    for (let index = fn.parameters.length - 1; index >= 0; index--) { budget.take(); pending.push(fn.parameters[index]); }
    while (pending.length) {
      budget.take(); const declaration = pending.pop()!;
      if (!ts.isParameter(declaration) && !ts.isBindingElement(declaration)) continue;
      if (ts.isIdentifier(declaration.name)) order.set(declaration, order.size);
      else for (let index = declaration.name.elements.length - 1; index >= 0; index--) {
        budget.take(); const element = declaration.name.elements[index]; if (!ts.isOmittedExpression(element)) pending.push(element);
      }
    }
    parameterOrders.set(fn, order); return order;
  };
  const defaultExits = (fn: ts.FunctionLikeDeclaration, args: Value[][], env: Environment, depth: number, request?: boolean, schedule = false, evaluator?: DefaultEvaluator): number => {
    const order = parameterOrder(fn), previousInitialization = activeInitializations.get(env);
    let cursor = 0;
    const initializedBinding = (declaration: ts.Declaration): void => {
      const position = order.get(declaration);
      if (position !== undefined) { cursor = Math.max(cursor, position + 1); activeInitializations.set(env, { order, cursor }); }
    };
    activeInitializations.set(env, { order, cursor });
    try {
    const evaluate = (expression: ts.Expression, possible: boolean, level: number, uncertain = false): number => {
      budget.take(); completionDepth(level);
      if (schedule) enqueue({ node: expression, env, request: uncertain && request === true ? false : request });
      const result = evaluator ? evaluator(expression, possible, level) : expressionExits(expression, env, level);
      return result | (possible ? NORMAL : 0);
    };
    const initialize = (input: PatternInput, initializer: ts.Expression | undefined, level: number): { input: PatternInput; exits: number } => {
      budget.take(); completionDepth(level);
      if (!initializer) return { input, exits: NORMAL };
      const kept: Value[] = []; let missing = false;
      for (const value of input.values) { budget.take(); if (isUndefinedValue(value)) missing = true; else append(kept, [value]); }
      if (!missing && !input.uncertain) return { input, exits: NORMAL };
      const exits = evaluate(initializer, kept.length > 0 || input.uncertain, level + 1, !missing && input.uncertain);
      if (!(exits & NORMAL)) return { input, exits };
      const defaults = patternValues(resolve(initializer, env));
      append(kept, defaults.length ? defaults : [{ node: initializer, env }]);
      return { input: { values: kept, uncertain: input.uncertain || !defaults.length }, exits };
    };
    const bindPattern = (name: ts.BindingName, input: PatternInput, level: number): number => {
      budget.take(); completionDepth(level);
      if (ts.isIdentifier(name)) return NORMAL;
      const valid: PatternInput = { values: [], uncertain: input.uncertain };
      let exits = input.uncertain ? NORMAL | THROW : 0;
      for (const value of input.values) {
        budget.take();
        if (isUndefinedValue(value) || value.node.kind === ts.SyntaxKind.NullKeyword) { exits |= THROW; continue; }
        const iterable = ts.isArrayLiteralExpression(value.node) || ts.isStringLiteralLike(value.node)
          || ts.isExpression(value.node) && collectionKind(value.node, value.env) === "array";
        const nonIterable = ts.isObjectLiteralExpression(value.node) || ts.isNumericLiteral(value.node)
          || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(value.node.kind) || callable(value.node);
        if (ts.isArrayBindingPattern(name) && !iterable && nonIterable) { exits |= THROW; continue; }
        append(valid.values, [value]); exits |= NORMAL;
      }
      if (!(exits & NORMAL)) return exits;
      for (let index = 0; index < name.elements.length && exits & NORMAL; index++) {
        budget.take(); const element = name.elements[index];
        if (ts.isOmittedExpression(element)) continue;
        let key = ts.isIdentifier(element.name) ? element.name.text : undefined;
        if (element.propertyName) {
          if (ts.isComputedPropertyName(element.propertyName)) {
            exits = (exits & THROW) | evaluate(element.propertyName.expression, false, level + 1, valid.uncertain);
            if (!(exits & NORMAL)) break;
            const selected = literal(element.propertyName.expression, env);
            key = selected && (ts.isStringLiteralLike(selected) || ts.isNumericLiteral(selected)) ? selected.text : undefined;
          } else key = propertyName(element.propertyName);
        }
        const selected = element.dotDotDotToken ? unknownPattern(element, env) : patternProperty(valid, key, ts.isArrayBindingPattern(name) ? index : undefined, element, env);
        const initialized = initialize(selected, element.initializer, level + 1);
        exits = (exits & THROW) | initialized.exits;
        env.parameters.set(element, initialized.input.values);
        if (exits & NORMAL) {
          exits = (exits & THROW) | bindPattern(element.name, initialized.input, level + 1);
          if (exits & NORMAL && ts.isIdentifier(element.name)) initializedBinding(element);
        }
      }
      return exits;
    };
    let exits = NORMAL;
    for (let index = 0; index < fn.parameters.length && exits & NORMAL; index++) {
      budget.take(); const parameter = fn.parameters[index];
      if (ts.isIdentifier(parameter.name)) {
        if (parameter.initializer && takesDefault(args[index])) {
          const possible = !!args[index]?.some(value => { budget.take(); return !isUndefinedValue(value); });
          exits = (exits & THROW) | evaluate(parameter.initializer, possible, depth + 1);
        }
        if (exits & NORMAL) initializedBinding(parameter);
        continue;
      }
      const actual = parameter.dotDotDotToken ? restValues(args, index, env) : args[index];
      const input = actual === undefined ? { values: [undefinedValue], uncertain: false }
        : actual.length || collectionContainers.has(actual) ? { values: patternValues(actual), uncertain: false } : unknownPattern(parameter, env);
      const initialized = initialize(input, parameter.initializer, depth + 1);
      exits = (exits & THROW) | initialized.exits;
      if (exits & NORMAL) exits = (exits & THROW) | bindPattern(parameter.name, initialized.input, depth + 1);
    }
    const previousOutcome = completedInitializations.get(env);
    if (previousOutcome && !(previousOutcome.exits & NORMAL)) failedInitializationCount--;
    if (!(exits & NORMAL)) failedInitializationCount++;
    completedInitializations.set(env, { state: { order, cursor }, exits });
    return exits;
    } finally {
      if (previousInitialization) activeInitializations.set(env, previousInitialization);
      else activeInitializations.delete(env);
    }
  };
  const fieldEnvs = new WeakMap<Environment, Environment>();
  const fieldEnvironment = (env: Environment): Environment => {
    if (env.constructionReady) return env;
    let ready = fieldEnvs.get(env);
    if (!ready) { ready = { ...env, id: nextEnvironment++, constructionReady: true }; fieldEnvs.set(env, ready); }
    return ready;
  };
  const fieldExits = (owner: ts.ClassLikeDeclaration, env: Environment, depth: number): number => {
    let exits = NORMAL;
    for (const member of owner.members) {
      budget.take(); if (!(exits & NORMAL)) break;
      if (ts.isPropertyDeclaration(member) && member.initializer && !member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)) exits = (exits & THROW) | expressionExits(member.initializer, fieldPhaseEnvironment(owner, env, member), depth + 1);
    }
    return exits;
  };
  interface ReachedSuper { call: ts.CallExpression; env: Environment; position: number }
  const reachableSupers = (body: ts.Node, env: Environment): ReachedSuper[] => {
    const calls: ReachedSuper[] = [];
    const tasks: Array<{ body: ts.Node; env: Environment; position?: number; active: Set<ts.Node> }> = [{ body, env, active: new Set() }];
    while (tasks.length) {
      budget.take(); const task = tasks.pop()!;
      if (task.active.size > 128) throw new AnalysisLimitError("Request binding resolution depth limit exceeded");
      const pending: ts.Node[] = [task.body];
      while (pending.length) {
        budget.take(); const node = pending.pop()!;
        if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) continue;
        if (ts.isCallExpression(node)) {
          if (node.expression.kind === ts.SyntaxKind.SuperKeyword) calls.push({ call: node, env: task.env, position: task.position ?? node.pos });
          else for (const fn of callables(resolve(node.expression, task.env))) {
            budget.take();
            // Only invoked lexical arrows can legally close over this
            // constructor's super binding. Merely defining one is deferred.
            if (!ts.isArrowFunction(fn.node) || task.active.has(fn.node)) continue;
            let args = node.arguments.map(argument => resolve(argument, task.env));
            if (fn.bound) { budget.take(fn.bound.args.length + args.length); args = [...fn.bound.args, ...args]; }
            const inner = bind(fn, args, fn.env.receiver);
            if (defaultExits(fn.node, args, inner, 0) & NORMAL) {
              if (fn.node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
                for (const reached of synchronousSupers(fn.node.body, inner)) {
                  budget.take(); calls.push({ ...reached, position: task.position ?? node.pos });
                }
                continue;
              }
              budget.take(task.active.size + 1);
              tasks.push({ body: fn.node.body, env: inner, position: task.position ?? node.pos, active: new Set(task.active).add(fn.node) });
            }
          }
        }
        if (evaluatedChildren(node, task.env, pending)) continue;
        ts.forEachChild(node, child => { pending.push(child); });
      }
    }
    return calls;
  };
  const constructorReachedSupers = (fn: ts.ConstructorDeclaration, env: Environment): ReachedSuper[] => {
    const calls: ReachedSuper[] = [];
    for (const parameter of fn.parameters) {
      budget.take();
      if (parameter.initializer && env.parameters.get(parameter)?.some(value => { budget.take(); return value.node === parameter.initializer; })) {
        for (const reached of synchronousSupers(parameter.initializer, env)) { budget.take(); calls.push(reached); }
      }
    }
    if (fn.body) for (const reached of synchronousSupers(fn.body, env)) { budget.take(); calls.push(reached); }
    return calls;
  };
  const derivedClass = (owner: ts.ClassLikeDeclaration): boolean => !!owner.heritageClauses?.some(clause => { budget.take(); return clause.token === ts.SyntaxKind.ExtendsKeyword; });
  let nextFieldOwner = 1;
  const phaseFields = new WeakMap<ts.ClassLikeDeclaration, ReadonlySet<ts.PropertyDeclaration>>();
  const phaseReceivers = new Map<string, Value>();
  const phaseEnvironments = new WeakMap<Environment, WeakMap<ts.PropertyDeclaration, Environment>>();
  const fieldPhaseEnvironment = (owner: ts.ClassLikeDeclaration, env: Environment, before: ts.PropertyDeclaration): Environment => {
    let entries = phaseEnvironments.get(env);
    if (!entries) { entries = new WeakMap(); phaseEnvironments.set(env, entries); }
    let ready = entries.get(before);
    if (!ready) { ready = { ...env, id: nextEnvironment++, constructionReady: true, fieldPhase: { owner, before } }; entries.set(before, ready); }
    return ready;
  };
  const phaseReceiver = (value: Value, phase: NonNullable<Environment["fieldPhase"]>): Value => {
    const key = `${valueKey(value)}:${id(phase.owner)}:${id(phase.before)}`;
    const cached = phaseReceivers.get(key); if (cached) return cached;
    let fields = phaseFields.get(phase.owner);
    if (!fields) {
      const collected = new Set<ts.PropertyDeclaration>();
      for (const member of phase.owner.members) { budget.take(); if (ts.isPropertyDeclaration(member) && !member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)) collected.add(member); }
      fields = collected; phaseFields.set(phase.owner, fields);
    }
    const selected = { ...value, fieldOwner: { id: nextFieldOwner++, owner: phase.owner, env: value.env, fields, before: phase.before, previous: value.fieldOwner } };
    phaseReceivers.set(key, selected); return selected;
  };
  const replacementFields = new WeakMap<ts.Node, Map<string, Value>>();
  const initializedReplacement = (value: Value, owner: ts.ClassLikeDeclaration, env: Environment): Value => {
    if (value.fieldOwner?.owner === owner && value.fieldOwner.env === env) return value;
    const contexts = replacementFields.get(value.node) ?? new Map<string, Value>();
    const key = `${valueKey(value)}:${id(owner)}:${env.id}`;
    const cached = contexts.get(key); if (cached) return cached;
    const fields = new Set<ts.PropertyDeclaration>();
    // Field initializers execute against the object returned by super, with
    // only earlier fields installed. The overlay also avoids re-constructing
    // that object while resolving a this-dependent initializer.
    const overlay: Value = { ...value, fieldOwner: { id: nextFieldOwner++, owner, env, fields, previous: value.fieldOwner } };
    const ready: Environment = { id: nextEnvironment++, closure: env, parameters: new Map(), receiver: overlay, constructionReady: true };
    contexts.set(key, overlay); replacementFields.set(value.node, contexts);
    try {
      let completed = true;
      for (const member of owner.members) {
        budget.take();
        if (!ts.isPropertyDeclaration(member) || member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)) continue;
        if (member.initializer && !(expressionExits(member.initializer, ready) & NORMAL)) { completed = false; break; }
        fields.add(member);
      }
      const known = !fields.size && completed || ts.isNewExpression(value.node) && completed ? value : overlay;
      contexts.set(key, known); return known;
    } catch (error) { contexts.delete(key); throw error; }

  };
  const fieldInstalled = (value: Value, member: ts.PropertyDeclaration): boolean => {
    for (let fields = value.fieldOwner; fields; fields = fields.previous) {
      budget.take(); if (fields.owner === member.parent) return fields.fields.has(member) && (!fields.before || member.pos < fields.before.pos);
      if (fields.before && (ts.isClassDeclaration(member.parent) || ts.isClassExpression(member.parent)) && derivesFrom(member.parent, fields.owner, value.env)) return false;
    }
    return true;
  };
  const derivesFrom = (owner: ts.ClassLikeDeclaration, target: ts.ClassLikeDeclaration, env: Environment, seen = new Set<ts.Node>()): boolean => {
    budget.take(); if (seen.has(owner)) return false;
    if (seen.size > 128) throw new AnalysisLimitError("Request binding resolution depth limit exceeded");
    const next = new Set(seen).add(owner);
    for (const clause of owner.heritageClauses ?? []) if (clause.token === ts.SyntaxKind.ExtendsKeyword) for (const type of clause.types) for (const parent of resolve(type.expression, env)) {
      budget.take(); if ((ts.isClassDeclaration(parent.node) || ts.isClassExpression(parent.node)) && (parent.node === target || derivesFrom(parent.node, target, parent.env, next))) return true;
    }
    return false;
  };
  // Installed own fields shadow prototype members regardless of declaration
  // order. Within either storage layer, a later declaration replaces an earlier
  // one; prefix receivers exclude fields whose initializer has not finished.
  const selectedClassMember = (owner: ts.ClassLikeDeclaration, name: string, instance: boolean, receiver: Value): ts.ClassElement | undefined => {
    let field: ts.PropertyDeclaration | undefined, prototype: ts.ClassElement | undefined;
    for (const member of owner.members) {
      budget.take();
      const isStatic = !!(ts.canHaveModifiers(member) && ts.getModifiers(member)?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword));
      if (propertyName(member.name) !== name || isStatic === instance) continue;
      if (ts.isPropertyDeclaration(member)) { if (fieldInstalled(receiver, member)) field = member; }
      else prototype = member;
    }
    return field ?? prototype;
  };
  const inheritedMemberValues = (owner: ts.ClassLikeDeclaration, env: Environment, receiver: Value, name: string, use: ts.Node, seen: Set<ts.Node>, factories: boolean, active = new Set<ts.Node>()): Value[] => {
    budget.take(); if (active.has(owner)) return [];
    if (active.size > 128) throw new AnalysisLimitError("Request binding resolution depth limit exceeded");
    const next = new Set(active).add(owner), values: Value[] = [];
    for (const clause of owner.heritageClauses ?? []) if (clause.token === ts.SyntaxKind.ExtendsKeyword) for (const type of clause.types) for (const parent of resolve(type.expression, env, type.expression, seen, factories)) {
      budget.take(); if (!ts.isClassDeclaration(parent.node) && !ts.isClassExpression(parent.node)) continue;
      const member = selectedClassMember(parent.node, name, true, receiver);
      if (member) {
        if (ts.isPropertyDeclaration(member) && !member.initializer) append(values, [undefinedValue]);
        else if (ts.isPropertyDeclaration(member) && member.initializer && ts.isArrowFunction(member.initializer) && replacement(member, use) === undefined) append(values, [{ node: member.initializer, env: { id: nextEnvironment++, closure: parent.env, parameters: new Map(), receiver } }]);
        else append(values, memberValues(resolve(member, parent.env, use, seen, factories), receiver));
      }
      if (!member) append(values, inheritedMemberValues(parent.node, parent.env, receiver, name, use, seen, factories, next));
    }
    return values;
  };
  const replacementField = (value: Value, name: string, use: ts.Node, seen: Set<ts.Node>, factories: boolean): Value[] | undefined => {
    for (let fields = value.fieldOwner; fields; fields = fields.previous) {
      budget.take();
      let found: ts.PropertyDeclaration | undefined;
      for (const member of fields.owner.members) {
        budget.take();
        if (ts.isPropertyDeclaration(member) && !member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword) && propertyName(member.name) === name
          && fields.fields.has(member) && (!fields.before || member.pos < fields.before.pos)) found = member;
      }
      if (!found) continue;
      const selected = replacement(found, use);
      if (selected === null) return [];
      if (selected === undefined && unsafeReceivers.has(fields.owner)) return [];
      const initializer = selected ?? found.initializer;
      if (!initializer) return [undefinedValue];
      const contexts = fieldEnvironments.get(found) ?? new Map<string, Environment>();
      const key = `replacement:${valueKey(value)}:${fields.id}`;
      let captured = contexts.get(key);
      if (!captured) {
        captured = { id: nextEnvironment++, closure: fields.env, parameters: new Map(), receiver: value, constructionReady: true };
        contexts.set(key, captured); fieldEnvironments.set(found, contexts);
      }
      const values = ts.isArrowFunction(initializer) ? [{ node: initializer, env: captured }] : resolve(initializer, captured, initializer, seen, factories);
      return memberValues(values, value);
    }
    return undefined;
  };
  const returnKind = (value: Value): "object" | "undefined" | "primitive" | "unknown" => {
    if (isUndefinedValue(value)) return "undefined";
    if (ts.isObjectLiteralExpression(value.node) || ts.isArrayLiteralExpression(value.node) || ts.isNewExpression(value.node) || callable(value.node)) return "object";
    if (ts.isNumericLiteral(value.node) || ts.isStringLiteralLike(value.node) || [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(value.node.kind)) return "primitive";
    return "unknown";
  };
  // Keep initialization attached to the paths that can actually complete.
  // A super call on a throwing branch cannot initialize a normal sibling.
  const BEFORE_SUPER = 1, AFTER_SUPER = 2;
  interface SuperFlow { callbackValues?: Value[]; callbackTruth?: boolean; normal: number; throws: number; suspended: number; returns: Map<ts.ReturnStatement, number>; breaks: number; continues: number }
  const superFlow = (normal: number): SuperFlow => ({ normal, throws: 0, suspended: 0, returns: new Map(), breaks: 0, continues: 0 });
  const mergeSuperFlow = (target: SuperFlow, source: SuperFlow): void => {
    target.normal |= source.normal; target.throws |= source.throws; target.suspended |= source.suspended; target.breaks |= source.breaks; target.continues |= source.continues;
    for (const [node, states] of source.returns) { budget.take(); target.returns.set(node, (target.returns.get(node) ?? 0) | states); }
  };
  const activeSuperArrows = new Set<ts.Node>();
  interface ConstructorInvocation { fn: Value; args: Value[][]; receiver?: Value; plan: ConstructorPlan }
  interface ConstructorPlan { id: number; calls: WeakSet<ts.Node>; targets: WeakMap<ts.Node, WeakMap<ts.Node, ConstructorInvocation[]>> }
  let nextConstructorPlan = 1;
  const constructorInvocations = new WeakMap<Environment, ConstructorPlan>();
  const constructorEntryKeys = new WeakMap<ConstructorInvocation[], Set<string>>();
  // Preserve each executed iteration with its own captured values and plan.
  // Unioning allowed calls would pair one iteration's effects with another
  // iteration's receiver, and replacing the plan would erase earlier effects.
  const recordConstructorInvocation = (parent: ConstructorPlan, call: ts.Node, fn: Value, args: Value[][], receiver: Value | undefined, plan: ConstructorPlan): void => {
    budget.take();
    let targets = parent.targets.get(call);
    if (!targets) { targets = new WeakMap(); parent.targets.set(call, targets); }
    let entries = targets.get(fn.node);
    if (!entries) { entries = []; targets.set(fn.node, entries); }
    let keys = constructorEntryKeys.get(entries);
    if (!keys) { keys = new Set(); constructorEntryKeys.set(entries, keys); }
    const key = `${valueKey(fn)}:${argumentSignature(args)}:${receiver ? valueKey(receiver) : ""}:${plan.id}`;
    if (keys.has(key)) return;
    keys.add(key);
    entries.push({ fn, args, receiver, plan });
  };
  const invokeConstructorEntries = (entries: ConstructorInvocation[] | undefined, request: boolean | undefined): boolean => {
    if (!entries) return false;
    for (const entry of entries) { budget.take(); invoke(entry.fn, entry.args, request, entry.receiver, entry.plan); }
    return true;
  };

  let recordingConstructor = false;
  let superCollector: ReachedSuper[] | undefined;
  let superCollectorPosition: number | undefined;
  const recordConstructorEnvironment = (env: Environment): WeakSet<ts.Node> | undefined => {
    if (!recordingConstructor || env.fn?.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return undefined;
    let known = constructorInvocations.get(env);
    if (!known) {
      known = { id: nextConstructorPlan++, calls: new WeakSet(), targets: new WeakMap() };
      constructorInvocations.set(env, known);
    }
    return known.calls;
  };
  const synchronousSupers = (body: ts.ConciseBody, env: Environment): ReachedSuper[] => {
    const previous = superCollector, previousRecording = recordingConstructor, calls: ReachedSuper[] = [];
    superCollector = calls; recordingConstructor = false;
    try {
      if (ts.isBlock(body)) superStatement(body, env, BEFORE_SUPER, 0);
      else superExpression(body, env, BEFORE_SUPER, 0);
      return calls;
    } finally { superCollector = previous; recordingConstructor = previousRecording; }
  };
  const inertArrays = new WeakMap<ts.ArrayLiteralExpression, boolean>();
  const inertArray = (node: ts.ArrayLiteralExpression): boolean => {
    const known = inertArrays.get(node); if (known !== undefined) return known;
    let inert = true;
    for (const element of node.elements) {
      budget.take();
      if (!ts.isOmittedExpression(element) && !ts.isNumericLiteral(element) && !ts.isStringLiteralLike(element)
        && ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(element.kind)) { inert = false; break; }
    }
    inertArrays.set(node, inert); return inert;
  };
  const superExpression = (node: ts.Expression | undefined, env: Environment, states: number, depth: number): SuperFlow => {
    if (!node || !states) return superFlow(states);
    if (ts.isArrayLiteralExpression(node) && inertArray(node)) { budget.take(); completionDepth(depth + (node.elements.length ? 1 : 0)); return superFlow(states); }
    const receivers: ts.Expression[] = [];
    let optional: ts.Node = node;
    while (ts.isCallExpression(optional) || ts.isPropertyAccessExpression(optional) || ts.isElementAccessExpression(optional)) {
      budget.take(); if (optional.questionDotToken) receivers.push(optional.expression);
      optional = optional.expression;
    }
    const skipped = superFlow(0);
    for (let index = receivers.length - 1; index >= 0; index--) {
      budget.take(); const selected = nullish(receivers[index], env);
      if (selected === true) return superExpression(receivers[index], env, states, depth + 1);
      if (selected === undefined) mergeSuperFlow(skipped, superExpression(receivers[index], env, states, depth + 1));
    }
    const result = superExpressionCore(node, env, states, depth);
    mergeSuperFlow(result, skipped); return result;
  };
  const superExpressionCore = (node: ts.Expression | undefined, env: Environment, states: number, depth: number): SuperFlow => {
    budget.take(); completionDepth(depth);
    if (!node || !states) return superFlow(states);
    const recorded = recordConstructorEnvironment(env);
    if (transparent(node)) return superExpression(node.expression, env, states, depth + 1);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)) return superFlow(states);
    if (node.kind === ts.SyntaxKind.ThisKeyword) { const result = superFlow(states & AFTER_SUPER); result.throws = states & BEFORE_SUPER; return result; }
    if (ts.isAwaitExpression(node)) {
      const result = superExpression(node.expression, env, states, depth + 1);
      result.suspended |= result.normal; result.normal = 0; return result;
    }
    if (ts.isConditionalExpression(node)) {
      const condition = superExpression(node.condition, env, states, depth + 1);
      const result = superFlow(0); result.throws = condition.throws; result.suspended = condition.suspended;
      const selected = truth(node.condition, env);
      if (selected !== false) mergeSuperFlow(result, superExpression(node.whenTrue, env, condition.normal, depth + 1));
      if (selected !== true) mergeSuperFlow(result, superExpression(node.whenFalse, env, condition.normal, depth + 1));
      return result;
    }
    if (ts.isBinaryExpression(node)) {
      const left = superExpression(node.left, env, states, depth + 1);
      const operator = node.operatorToken.kind;
      const selected = truth(node.left, env);
      const takeRight = operator === ts.SyntaxKind.AmpersandAmpersandToken ? selected
        : operator === ts.SyntaxKind.BarBarToken ? selected === undefined ? undefined : !selected
        : operator === ts.SyntaxKind.QuestionQuestionToken ? nullish(node.left, env) : true;
      if (takeRight === false) return left;
      const right = superExpression(node.right, env, left.normal, depth + 1);
      right.throws |= left.throws; right.suspended |= left.suspended; if (takeRight === undefined) right.normal |= left.normal;
      return right;
    }
    if (ts.isVoidExpression(node) || ts.isTypeOfExpression(node) || ts.isDeleteExpression(node) || ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      return superExpression(ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node) ? node.operand : node.expression, env, states, depth + 1);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const result = superFlow(states);
      // `super` is the constructor binding, not an uninitialized this read.
      if (node.expression.kind !== ts.SyntaxKind.SuperKeyword) {
        const callee = superExpression(node.expression, env, result.normal, depth + 1);
        result.normal = callee.normal; result.throws |= callee.throws; result.suspended |= callee.suspended;
      }
      for (const argument of node.arguments ?? []) {
        budget.take(); if (!result.normal) break;
        const value = superExpression(ts.isSpreadElement(argument) ? argument.expression : argument, env, result.normal, depth + 1);
        result.normal = value.normal; result.throws |= value.throws; result.suspended |= value.suspended;
      }
      if (!result.normal) return result;
      recorded?.add(node);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
        if (superCollector) { budget.take(); superCollector.push({ call: node, env, position: superCollectorPosition ?? node.pos }); }
        let bases = 0;
        for (let scope: Environment | undefined = env; scope; scope = scope.closure) {
          budget.take();
          if (!scope.fn || !ts.isConstructorDeclaration(scope.fn)) continue;
          const args = node.arguments.map(argument => resolve(argument, env));
          for (const clause of scope.fn.parent.heritageClauses ?? []) if (clause.token === ts.SyntaxKind.ExtendsKeyword) for (const type of clause.types) {
            const parents = resolve(type.expression, scope);
            if (!parents.length) bases |= NORMAL | THROW;
            for (const parent of parents) { budget.take(); bases |= constructorExits(parent, args, scope.receiver, depth + 1); }
          }
          if (bases & THROW) result.throws |= result.normal;
          const initialized = bases & NORMAL && result.normal & BEFORE_SUPER ? AFTER_SUPER : 0;
          result.throws |= result.normal & AFTER_SUPER;
          if (initialized) {
            // Discovering the receiver binding must not recursively evaluate
            // its own field initializers; ordinary completion evaluates them.
            const fields = superCollector ? NORMAL : fieldExits(scope.fn.parent, scope, depth + 1);
            if (fields & THROW) result.throws |= AFTER_SUPER;
            result.normal = fields & NORMAL ? AFTER_SUPER : 0;
          } else result.normal = 0;
          return result;
        }
        return result;
      }
      let targets = callables(resolve(node.expression, env));
      let supplied = (node.arguments ?? []).map(argument => resolve(argument, env));
      if (ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))
        && (ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : propertyName(node.expression.argumentExpression)) === "call") {
        const originals = nativeCallableMember(node.expression, env);
        if (originals.length) { targets = originals; supplied = supplied.slice(1); }
      }
      const native = synchronousConstructorCallbacks(node, env, result.normal, depth + 1);
      if (native) { native.throws |= result.throws; native.suspended |= result.suspended; return native; }
      let lexical = false;
      const called = superFlow(0);
      for (const fn of targets) {
        budget.take();
        if (!ts.isArrowFunction(fn.node) || activeSuperArrows.has(fn.node)) continue;
        lexical = true; activeSuperArrows.add(fn.node);
        const previousPosition = superCollectorPosition; superCollectorPosition ??= node.pos;
        try {
          let args = supplied;
          if (fn.bound) { budget.take(fn.bound.args.length + args.length); args = [...fn.bound.args, ...args]; }
          const inner = bind(fn, args, fn.env.receiver);
          const defaults = superDefaults(fn.node, args, inner, result.normal, depth + 1);
          const body = ts.isBlock(fn.node.body) ? superStatement(fn.node.body, inner, defaults.normal, depth + 1) : superExpression(fn.node.body, inner, defaults.normal, depth + 1);
          body.throws |= defaults.throws; body.suspended |= defaults.suspended;
          for (const initialized of body.returns.values()) { budget.take(); body.normal |= initialized; }
          body.returns.clear();
          if (fn.node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
            // An async arrow runs synchronously up to its first await. Throws
            // become rejected promises, retaining any this binding established.
            body.normal |= body.throws | body.suspended;
            body.throws = 0; body.suspended = 0;
          }
          mergeSuperFlow(called, body);
          const plan = constructorInvocations.get(inner), parent = constructorInvocations.get(env);
          if (recordingConstructor && plan && parent) {
            recordConstructorInvocation(parent, node, fn, supplied, fn.env.receiver, plan);
          }
        } finally { superCollectorPosition = previousPosition; activeSuperArrows.delete(fn.node); }
      }
      if (lexical && targets.every(fn => { budget.take(); return ts.isArrowFunction(fn.node); })) {
        called.throws |= result.throws; called.suspended |= result.suspended; return called;
      }
      const exits = expressionExits(node, env, depth + 1);
      if (exits & THROW) result.throws |= result.normal;
      if (!(exits & NORMAL)) result.normal = 0;
      if (lexical) mergeSuperFlow(result, called);
      return result;
    }
    // Property keys and computed receivers still evaluate in source order.
    const expressions: ts.Expression[] = [];
    const collect = (child: ts.Node): void => {
      budget.take();
      if (ts.isTypeNode(child)) return;
      if (ts.isFunctionLike(child)) {
        if (child.name && ts.isComputedPropertyName(child.name)) expressions.push(child.name.expression);
        return;
      }
      if (ts.isExpression(child)) { expressions.push(child); return; }
      ts.forEachChild(child, collect);
    };
    ts.forEachChild(node, collect);
    const result = superFlow(states);
    for (const expression of expressions) {
      budget.take(); const next = superExpression(expression, env, result.normal, depth + 1);
      result.normal = next.normal; result.throws |= next.throws; result.suspended |= next.suspended;
    }
    return result;
  };
  const constructorCallbackResults = new Map<string, CompletionSummary<{ flow: SuperFlow; plan?: ConstructorPlan; supers: ReachedSuper[] }>>();
  const constructorCallbackFlow = (fn: Value, supplied: Value[][], env: Environment, states: number, depth: number, call: ts.Node): SuperFlow => {
    budget.take(); completionDepth(depth);
    if (!ts.isArrowFunction(fn.node) || activeSuperArrows.has(fn.node)) return superFlow(states);
    // Arrows have lexical arguments. Surplus native callback arguments cannot
    // affect one without a rest parameter, so a changing unused index must not
    // manufacture thousands of distinct execution plans.
    if (!fn.node.parameters.some(parameter => { budget.take(); return !!parameter.dotDotDotToken; })) {
      const length = Math.min(supplied.length, Math.max(0, fn.node.parameters.length - (fn.bound?.args.length ?? 0)));
      if (length !== supplied.length) { budget.take(length); supplied = supplied.slice(0, length); }
    }
    const parent = constructorInvocations.get(env);
    const key = `${valueKey(fn)}:${argumentSignature(supplied)}:${env.id}:${states}:${id(call)}:${recordingConstructor ? parent?.id ?? -1 : 0}:${superCollector ? 1 : 0}:${initializationSignature()}`;
    const cached = constructorCallbackResults.get(key);
    if (cached) {
      const known = reuseCompletion(cached, depth);
      if (superCollector) for (const reached of known.supers) { budget.take(); superCollector.push(reached); }
      if (recordingConstructor && known.plan && parent) recordConstructorInvocation(parent, call, fn, supplied, fn.env.receiver, known.plan);
      return known.flow;
    }
    const frame = startCompletion(depth), cycles = resolutionCycles, before = superCollector?.length ?? 0;
    activeSuperArrows.add(fn.node);
    const previousPosition = superCollectorPosition; superCollectorPosition ??= call.pos;
    try {
      let args = supplied;
      if (fn.bound) { budget.take(fn.bound.args.length + args.length); args = [...fn.bound.args, ...args]; }
      const inner = bind(fn, args, fn.env.receiver);
      const defaults = superDefaults(fn.node, args, inner, states, depth + 1);
      const body = ts.isBlock(fn.node.body) ? superStatement(fn.node.body, inner, defaults.normal, depth + 1) : superExpression(fn.node.body, inner, defaults.normal, depth + 1);
      body.throws |= defaults.throws; body.suspended |= defaults.suspended;
      const values: Value[] = [];
      let selected: boolean | undefined, observed = false, mixed = false;
      const returned = (expression: ts.Expression | undefined): void => {
        budget.take();
        const current = expression ? truth(expression, inner) : false;
        if (observed && current !== selected) mixed = true;
        selected = current; observed = true;
        append(values, expression ? payloadValues(resolve(expression, inner, expression, new Set(), true)) : [undefinedValue]);
      };
      if (ts.isBlock(fn.node.body)) {
        if (body.normal) returned(undefined);
        for (const [statement, initialized] of body.returns) { budget.take(); body.normal |= initialized; returned(statement.expression); }
      } else returned(fn.node.body);
      body.returns.clear(); body.callbackValues = values.length ? values : [{ node: call, env }]; body.callbackTruth = mixed ? undefined : selected;
      if (fn.node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
        body.normal |= body.throws | body.suspended; body.throws = 0; body.suspended = 0;
        body.callbackValues = [{ node: call, env }]; body.callbackTruth = true;
      }
      const plan = constructorInvocations.get(inner);
      if (recordingConstructor && plan && parent) {
        recordConstructorInvocation(parent, call, fn, supplied, fn.env.receiver, plan);
      }
      if (cycles === resolutionCycles) {
        const supers: ReachedSuper[] = [];
        if (superCollector) for (let index = before; index < superCollector.length; index++) { budget.take(); supers.push(superCollector[index]); }
        constructorCallbackResults.set(key, completionSummary({ flow: body, plan, supers }, frame));
      }
      return body;
    } finally { superCollectorPosition = previousPosition; activeSuperArrows.delete(fn.node); finishCompletion(frame); }
  };
  const synchronousConstructorCallbacks = (node: ts.CallExpression | ts.NewExpression, env: Environment, states: number, depth: number): SuperFlow | undefined => {
    budget.take(); completionDepth(depth);
    let callback: ts.Expression | undefined, shape: ArrayShape | undefined, source: ts.Expression | undefined;
    let method = "executor", possible = false, swallowed = false, from = false;
    if (ts.isNewExpression(node) && nativeGlobal(node.expression, "Promise")) { callback = node.arguments?.[0]; swallowed = true; }
    else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const owner = node.expression.expression; method = node.expression.name.text;
      from = nativeGlobal(owner, "Array") && method === "from";
      if (!from && (!CALLBACK_METHODS.has(method) || ["then", "catch", "finally"].includes(method) || mutatedCollectionGlobals.has("Array") || collectionKind(owner, env) !== "array")) return undefined;
      callback = node.arguments[from ? 1 : 0]; source = from ? node.arguments[0] : owner;
      shape = source && arrayElements(source, env);
      if (!shape && from && source && emptyArrayLike(source, env)) shape = { items: [], holes: [] };
      possible = !shape;
    } else return undefined;
    if (!callback) return undefined;
    const resolved = resolve(callback, env, callback, new Set(), true);
    const containerCallback = collectionContainers.get(resolved);
    const alternatives = containerCallback ? [containerCallback] : runtimeUnions.get(resolved)?.values ?? resolved;
    const functions = callables(alternatives);
    let invalid = false;
    for (const value of alternatives) { budget.take(); if (ts.isArrayLiteralExpression(value.node) || ts.isObjectLiteralExpression(value.node) || ts.isNumericLiteral(value.node) || ts.isStringLiteralLike(value.node) || isUndefinedValue(value) || [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(value.node.kind)) invalid = true; }
    if (!functions.length) { const result = superFlow(invalid ? 0 : states); if (invalid) result.throws = states; return result; }
    const indices: number[] = [];
    if (shape) {
      const visitHoles = from || ["find", "findIndex"].includes(method);
      for (let index = 0; index < shape.items.length; index++) { budget.take(); if (!shape.holes[index] || visitHoles) indices.push(index); }
      // A compact hole range preserves its logical length. Constructor state
      // has only uninitialized/initialized states: the first and repeated
      // positive-index transitions suffice, without allocating runtime length.
      if ((visitHoles || !shape.holes[0]) && shape.logicalLength && shape.logicalLength > shape.items.length && shape.logicalLength > 1) indices.push(1);
    } else indices.push(0);
    if (method === "reduceRight") { budget.take(indices.length); indices.reverse(); }
    const reducing = method === "reduce" || method === "reduceRight", sorting = method === "sort";
    const result = superFlow(possible ? states : 0);
    if (invalid) result.throws |= states;
    const container = source && collectionExpression(source, env);
    for (const fn of functions) {
      budget.take(); let current = superFlow(states), accumulator: Value[] = [];
      let start = 0, count = swallowed ? 1 : indices.length;
      if (reducing) {
        if ((node.arguments?.length ?? 0) > 1) accumulator = payloadValues(resolve(node.arguments![1], env, node.arguments![1], new Set(), true));
        else { if (!indices.length) { current.normal = 0; current.throws = states; } accumulator = shape?.items[indices[0]] ?? [{ node, env }]; start = 1; }
      }
      if (sorting) {
        const present: number[] = [];
        for (const index of indices) { budget.take(); const item = shape?.items[index]; if (!item || !item.every(value => { budget.take(); return isUndefinedValue(value); })) present.push(index); }
        indices.length = 0;
        for (const index of present) { budget.take(); indices.push(index); }
        count = Math.min(2, Math.max(0, indices.length - 1));
      }
      for (let position = start; position < count; position++) {
        budget.take(); if (!current.normal) break;
        const index = indices[position] ?? 0;
        const payload = shape ? shape.holes[index] || shape.logicalLength && index >= shape.items.length ? [undefinedValue] : shape.items[index] ?? [undefinedValue] : [{ node, env }];
        const indexValue = [{ node: ts.factory.createNumericLiteral(index), env: empty }];
        const arrayValue = container ? [container] : [{ node, env }];
        const supplied = swallowed ? [[{ node, env }], [{ node, env }]] : reducing ? [accumulator, payload, indexValue, arrayValue]
          : sorting ? [shape?.items[indices[0]] ?? [{ node, env }], shape?.items[indices[1]] ?? [{ node, env }]]
          : from ? [payload, indexValue] : [payload, indexValue, arrayValue];
        const next = constructorCallbackFlow(fn, supplied, env, current.normal, depth + 1, node);
        current.normal = next.normal; current.throws |= next.throws; current.suspended |= next.suspended;
        if (reducing) accumulator = next.callbackValues ?? [{ node, env }];
        const stop = method === "some" || method === "find" || method === "findIndex" ? next.callbackTruth : method === "every" ? next.callbackTruth === undefined ? undefined : !next.callbackTruth : false;
        if (["some", "every", "find", "findIndex"].includes(method)) {
          if (stop !== false) result.normal |= current.normal;
          if (stop === true) { current.normal = 0; break; }
        }
      }
      if (swallowed) { current.normal |= current.throws; current.throws = 0; }
      mergeSuperFlow(result, current);
    }
    return result;
  };
  const superDefaults = (fn: ts.FunctionLikeDeclaration, args: Value[][], env: Environment, states: number, depth: number): SuperFlow => {
    budget.take(); completionDepth(depth);
    const result = superFlow(states);
    const exits = defaultExits(fn, args, env, depth, undefined, false, (expression, possible, nextDepth) => {
      const original = result.normal, next = superExpression(expression, env, original, nextDepth);
      result.normal = next.normal | (possible ? original : 0); result.throws |= next.throws; result.suspended |= next.suspended;
      return (result.normal ? NORMAL : 0) | (next.throws ? THROW : 0);
    });
    if (!(exits & NORMAL)) { result.throws |= result.normal; result.normal = 0; }
    else if (exits & THROW) result.throws |= result.normal;
    return result;
  };
  const superStatement = (node: ts.Node, env: Environment, states: number, depth: number): SuperFlow => {
    budget.take(); completionDepth(depth);
    if (!states) return superFlow(0);
    recordConstructorEnvironment(env);
    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      const result = superFlow(states);
      for (const statement of node.statements) {
        budget.take(); if (!result.normal) break;
        const next = superStatement(statement, env, result.normal, depth + 1);
        result.normal = 0; mergeSuperFlow(result, next);
      }
      return result;
    }
    if (ts.isExpressionStatement(node)) return superExpression(node.expression, env, states, depth + 1);
    if (ts.isVariableStatement(node)) {
      const result = superFlow(states);
      for (const declaration of node.declarationList.declarations) {
        budget.take(); const next = superExpression(declaration.initializer, env, result.normal, depth + 1);
        result.normal = next.normal; result.throws |= next.throws; result.suspended |= next.suspended;
      }
      return result;
    }
    if (ts.isReturnStatement(node)) {
      const result = superExpression(node.expression, env, states, depth + 1);
      if (result.normal) result.returns.set(node, result.normal);
      result.normal = 0; return result;
    }
    if (ts.isThrowStatement(node)) { const result = superExpression(node.expression, env, states, depth + 1); result.throws |= result.normal; result.normal = 0; return result; }
    if (ts.isIfStatement(node)) {
      const condition = superExpression(node.expression, env, states, depth + 1);
      const result = superFlow(0); result.throws = condition.throws; result.suspended = condition.suspended;
      const selected = truth(node.expression, env);
      if (selected !== false) mergeSuperFlow(result, superStatement(node.thenStatement, env, condition.normal, depth + 1));
      if (selected !== true) mergeSuperFlow(result, node.elseStatement ? superStatement(node.elseStatement, env, condition.normal, depth + 1) : superFlow(condition.normal));
      return result;
    }
    if (ts.isTryStatement(node)) {
      let result = superStatement(node.tryBlock, env, states, depth + 1);
      if (node.catchClause && result.throws) {
        const caught = superStatement(node.catchClause.block, env, result.throws, depth + 1);
        result.throws = 0; mergeSuperFlow(result, caught);
      }
      if (node.finallyBlock) {
        const completed = superFlow(0); completed.suspended = result.suspended;
        const finish = (input: number, original?: ts.ReturnStatement, throwing = false): void => {
          if (!input) return;
          const final = superStatement(node.finallyBlock!, env, input, depth + 1);
          if (original && final.normal) completed.returns.set(original, (completed.returns.get(original) ?? 0) | final.normal);
          else if (throwing) completed.throws |= final.normal;
          else completed.normal |= final.normal;
          final.normal = 0; mergeSuperFlow(completed, final);
        };
        finish(result.normal); finish(result.throws, undefined, true);
        for (const [returned, initialized] of result.returns) { budget.take(); finish(initialized, returned); }
        result = completed;
      }
      return result;
    }
    if (ts.isBreakStatement(node)) { const result = superFlow(0); result.breaks = states; return result; }
    if (ts.isContinueStatement(node)) { const result = superFlow(0); result.continues = states; return result; }
    // Unsupported control structures retain every feasible initialization
    // state; they cannot provide a definite proof that super ran.
    const recorded = recordConstructorEnvironment(env);
    if (recorded) {
      const pending: ts.Node[] = [node];
      while (pending.length) {
        budget.take(); const current = pending.pop()!;
        if (ts.isFunctionLike(current)) continue;
        if (ts.isCallExpression(current) || ts.isNewExpression(current)) recorded.add(current);
        ts.forEachChild(current, child => { pending.push(child); });
      }
    }
    const flow = statementFlow(node, env, depth + 1);
    const possible = reachableSupers(node, env).length ? states | AFTER_SUPER : states;
    const result = superFlow(flow.exits & NORMAL ? possible : 0);
    result.throws = flow.exits & THROW ? possible : 0;
    for (const returned of flow.returns) { budget.take(); result.returns.set(returned, possible); }
    return result;
  };
  const derivedCompletion = (fn: ts.ConstructorDeclaration, args: Value[][], env: Environment, depth: number): number => {
    const defaults = superDefaults(fn, args, env, BEFORE_SUPER, depth + 1);
    const flow = fn.body ? superStatement(fn.body, env, defaults.normal, depth + 1) : superFlow(defaults.normal);
    let exits = defaults.throws || flow.throws ? THROW : 0;
    if (flow.normal & AFTER_SUPER) exits |= NORMAL;
    if (flow.normal & BEFORE_SUPER) exits |= THROW;
    for (const [returned, states] of flow.returns) {
      budget.take();
      if (!returned.expression) { exits |= states & AFTER_SUPER ? NORMAL : 0; exits |= states & BEFORE_SUPER ? THROW : 0; continue; }
      const values = resolve(returned.expression, env, returned.expression, new Set(), true);
      if (!values.length) exits |= NORMAL | THROW;
      for (const result of values) {
        budget.take(); const kind = returnKind(result);
        exits |= kind === "object" ? NORMAL : kind === "primitive" ? THROW : kind === "undefined" ? (states & AFTER_SUPER ? NORMAL : 0) | (states & BEFORE_SUPER ? THROW : 0) : NORMAL | THROW;
      }
    }
    return exits;
  };
  const constructionResults = new Map<string, CompletionSummary<number>>();
  const activeConstructions = new Set<ts.Node>();
  const constructorExits = (value: Value, args: Value[][], instance: Value | undefined, depth: number): number => {
    budget.take();
    completionDepth(depth);
    if (!ts.isClassDeclaration(value.node) && !ts.isClassExpression(value.node) || activeConstructions.has(value.node)) return NORMAL | THROW;
    const key = `${valueKey(value)}:${instance ? valueKey(instance) : ""}:${argumentSignature(args)}:${initializationSignature()}`;
    const known = constructionResults.get(key); if (known !== undefined) return reuseCompletion(known, depth);
    activeConstructions.add(value.node);
    const frame = startCompletion(depth);
    try {
      const owner = value.node, derived = derivedClass(owner);
      const constructor = owner.members.find(member => { budget.take(); return ts.isConstructorDeclaration(member) && !!member.body; });
      if (!constructor || !callable(constructor)) {
        const env: Environment = { id: nextEnvironment++, closure: value.env, parameters: new Map(), receiver: instance };
        let exits = derived ? 0 : NORMAL;
        if (derived) for (const heritage of owner.heritageClauses ?? []) if (heritage.token === ts.SyntaxKind.ExtendsKeyword) for (const type of heritage.types) {
          const parents = resolve(type.expression, value.env);
          if (!parents.length) exits |= NORMAL | THROW;
          for (const parent of parents) { budget.take(); exits |= constructorExits(parent, args, instance, depth + 1); }
        }
        if (exits & NORMAL) exits = (exits & THROW) | fieldExits(owner, env, depth + 1);
        constructionResults.set(key, completionSummary(exits, frame)); return exits;
      }
      const env = bind({ node: constructor, env: value.env }, args, instance);
      let exits = derived ? NORMAL : fieldExits(owner, env, depth + 1);
      if (exits & NORMAL) exits = (exits & THROW) | defaultExits(constructor, args, env, depth + 1);
      if (!(exits & NORMAL)) { constructionResults.set(key, completionSummary(exits, frame)); return exits; }
      const flow = statementFlow(constructor.body, env, depth + 1);
      let completed = flow.exits & THROW;
      if (!derived) completed |= flow.exits & (NORMAL | RETURN) ? NORMAL : 0;
      else completed = derivedCompletion(constructor as ts.ConstructorDeclaration, args, env, depth + 1);
      exits = (exits & THROW) | completed;
      constructionResults.set(key, completionSummary(exits, frame)); return exits;
    } finally { finishCompletion(frame); activeConstructions.delete(value.node); }
  };
  const scheduleInvocation = (fn: Value, args: Value[][], env: Environment, request?: boolean): void => {
    if (!callable(fn.node)) return;
    if (ts.isConstructorDeclaration(fn.node) && !derivedClass(fn.node.parent) && !initializeFields(fn.node.parent, env, request)) return;
    const entry = defaultExits(fn.node, args, env, 0, request, true);
    if (!(entry & NORMAL)) return;
    if (ts.isConstructorDeclaration(fn.node) && derivedClass(fn.node.parent)) {
      const previous = recordingConstructor; recordingConstructor = true;
      try {
        const defaults = superDefaults(fn.node, args, env, BEFORE_SUPER, 0);
        if (defaults.normal) superStatement(fn.node.body, env, defaults.normal, 0);
      } finally { recordingConstructor = previous; }
    }
    enqueue({ node: fn.node.body, env, request });
  };
  const activeThis = new Set<Environment>();
  const constructorSupers = new WeakMap<Environment, ReachedSuper[]>();
  const thisValues = (use: ts.Node, env: Environment, seen: Set<ts.Node>, factories: boolean): Value[] => {
    let scope: Environment | undefined = env;
    while (scope && (!scope.fn || ts.isArrowFunction(scope.fn))) { budget.take(); scope = scope.closure; }
    if (!scope?.fn || !ts.isConstructorDeclaration(scope.fn) || !derivedClass(scope.fn.parent)) return env.receiver ? [env.fieldPhase ? phaseReceiver(env.receiver, env.fieldPhase) : env.receiver] : [];
    if (!scope.receiver) return [];
    if (activeThis.has(scope)) { resolutionCycles++; return []; }
    activeThis.add(scope);
    try {
      let calls = constructorSupers.get(scope);
      if (!calls) {
        calls = constructorReachedSupers(scope.fn, scope);
        constructorSupers.set(scope, calls);
      }
      const values: Value[] = [];
      for (const reached of calls) {
        const call = reached.call;
        budget.take(); if (!scope.constructionReady && reached.position >= use.pos) continue;
        const args = call.arguments.map(argument => resolve(argument, reached.env, argument, seen, factories));
        for (const clause of scope.fn.parent.heritageClauses ?? []) if (clause.token === ts.SyntaxKind.ExtendsKeyword) for (const type of clause.types) for (const parent of resolve(type.expression, scope, type.expression, seen, true)) {
          budget.take();
          for (const value of replacementInstances(parent, args, scope.receiver, seen, factories)) {
            budget.take(); append(values, [env.fieldPhase ? phaseReceiver(value, env.fieldPhase) : initializedReplacement(value, scope.fn.parent, scope.closure ?? scope)]);
          }
        }
      }
      return values;
    } finally { activeThis.delete(scope); }
  };
  const instanceResults = new WeakMap<ts.NewExpression, Map<string, BindingSummary>>();
  const activeInstances = new Set<string>();
  const replacementInstances = (value: Value, args: Value[][], instance: Value, seen: Set<ts.Node>, factories: boolean, heritageSeen = new Set<ts.Node>()): Value[] => {
    budget.take();
    if (!ts.isClassDeclaration(value.node) && !ts.isClassExpression(value.node)) return [instance];
    if (heritageSeen.has(value.node)) { resolutionCycles++; return []; }
    if (heritageSeen.size > 128) throw new AnalysisLimitError("Request binding resolution depth limit exceeded");
    const chain = new Set(heritageSeen).add(value.node), owner = value.node, derived = derivedClass(owner);
    const constructor = owner.members.find(member => { budget.take(); return ts.isConstructorDeclaration(member) && !!member.body; });
    const inner: Environment = constructor && callable(constructor) ? bind({ node: constructor, env: value.env }, args, instance)
      : { id: nextEnvironment++, closure: value.env, parameters: new Map(), receiver: instance };
    const flow = constructor && callable(constructor) ? statementFlow(constructor.body, inner) : undefined;
    const supers = constructor && ts.isConstructorDeclaration(constructor) && callable(constructor) ? constructorReachedSupers(constructor, inner) : [];
    const normal: Value[] = [];
    if (!derived) append(normal, [instance]);
    else for (const clause of owner.heritageClauses ?? []) if (clause.token === ts.SyntaxKind.ExtendsKeyword) for (const type of clause.types) {
      const inheritedArgs = constructor ? supers.map(reached => { budget.take(); return reached.call.arguments.map(argument => resolve(argument, reached.env, argument, seen, true)); }) : [args];
      for (const supplied of inheritedArgs) for (const parent of resolve(type.expression, value.env, type.expression, seen, true)) {
        budget.take(); append(normal, replacementInstances(parent, supplied, instance, seen, factories, chain));
      }
    }
    if (derived) for (let index = 0; index < normal.length; index++) { budget.take(); normal[index] = initializedReplacement(normal[index], owner, value.env); }
    if (!flow) return normal;
    const values: Value[] = [];
    if (flow.exits & NORMAL) append(values, normal);
    for (const returned of flow.returns) {
      budget.take();
      if (!returned.expression) { if (!derived || supers.some(call => { budget.take(); return call.position < returned.pos; })) append(values, normal); continue; }
      let result: ts.Expression = returned.expression;
      while (transparent(result)) { budget.take(); result = result.expression; }
      const resolved = ts.isObjectLiteralExpression(result) || ts.isArrayLiteralExpression(result) ? [{ node: result, env: inner }] : resolve(result, inner, result, seen, true);
      for (const replacement of resolved) {
        budget.take(); const kind = returnKind(replacement);
        if (kind === "object") append(values, [replacement]);
        else if (!derived && (kind === "primitive" || kind === "undefined") || derived && kind === "undefined" && supers.some(call => { budget.take(); return call.position < returned.pos; })) append(values, normal);
      }
    }
    return values;
  };
  const instanceValues = (instance: Value, seen = new Set<ts.Node>(), factories = false): Value[] => {
    budget.take();
    if (!ts.isNewExpression(instance.node) || instance.fieldOwner) return [instance];
    const expression = instance.node;
    // A direct external/native constructor has no analyzed replacement body.
    // Retain its allocation without creating a summary for this empty lookup.
    if (ts.isIdentifier(expression.expression) && !symbolOf(expression.expression)?.declarations?.length) {
      if (seen.size > 128) throw new AnalysisLimitError("Request binding resolution depth limit exceeded");
      return [instance];
    }
    const contextKey = `${instance.env.id}:${factories ? 1 : 0}`;
    const contexts = instanceResults.get(expression) ?? new Map<string, BindingSummary>();
    const known = reuseBinding(contexts.get(contextKey), seen); if (known) return known;
    const activeKey = `${id(expression)}:${contextKey}`;
    if (activeInstances.has(activeKey)) { resolutionCycles++; return []; }
    activeInstances.add(activeKey);
    const values: Value[] = [];
    const frame = startBinding(seen.size, expression), epoch = resolutionEpoch, cycles = resolutionCycles;
    try {
      const declarations = resolve(expression.expression, instance.env, expression.expression, seen, true);
      if (!declarations.length) append(values, [instance]);
      const args = (expression.arguments ?? []).map(argument => resolve(argument, instance.env, argument, seen, true));
      for (const value of declarations) {
        budget.take();
        if (!ts.isClassDeclaration(value.node) && !ts.isClassExpression(value.node)) continue;
        if (constructorExits(value, args, instance, 0) & NORMAL) append(values, replacementInstances(value, args, instance, seen, factories));
      }
      if (epoch === resolutionEpoch && cycles === resolutionCycles) { contexts.set(contextKey, bindingSummary(values, frame, epoch)); instanceResults.set(expression, contexts); }
      return values;
    } finally { resolutionFrames.pop(); activeInstances.delete(activeKey); }
  };
  interface CallEvaluation { children: ts.Node[]; invokes: boolean }
  const simpleAccesses = new WeakMap<ts.Node, boolean>();
  const simpleAccess = (node: ts.Node): boolean => {
    const pending: ts.Node[] = [];
    let current = node, result = false;
    for (;;) {
      const known = simpleAccesses.get(current);
      if (known !== undefined) { result = known; break; }
      budget.take(); pending.push(current);
      if (ts.isIdentifier(current) || current.kind === ts.SyntaxKind.ThisKeyword) { result = true; break; }
      if (transparent(current) || ts.isPropertyAccessExpression(current)) { current = current.expression; continue; }
      if (ts.isElementAccessExpression(current) && (ts.isStringLiteralLike(current.argumentExpression) || ts.isNumericLiteral(current.argumentExpression))) { current = current.expression; continue; }
      break;
    }
    for (const part of pending) { budget.take(); simpleAccesses.set(part, result); }
    return result;
  };
  const callEvaluation = (node: ts.CallExpression | ts.NewExpression, env: Environment, evaluate = true): CallEvaluation => {
    const children: ts.Node[] = [node.expression];
    if (!evaluate) {
      for (const argument of node.arguments ?? []) { budget.take(); children.push(argument); }
      return { children, invokes: true };
    }
    if (!(expressionExits(node.expression, env) & NORMAL)) return { children, invokes: false };
    // A computed callee key must finish on the path that actually calls the
    // function. A skipped optional branch is not proof that a throwing key
    // produced a callable value.
    let callee: ts.Node = node.expression;
    while (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
      budget.take();
      if (ts.isElementAccessExpression(callee) && !(expressionExits(callee.argumentExpression, env) & NORMAL)) return { children, invokes: false };
      callee = callee.expression;
    }
    for (const argument of node.arguments ?? []) {
      budget.take(); children.push(argument);
      if (!(expressionExits(ts.isSpreadElement(argument) ? argument.expression : argument, env) & NORMAL)) return { children, invokes: false };
    }
    return { children, invokes: true };
  };
  const evaluatedChildren = (node: ts.Node, env: Environment, pending: ts.Node[]): boolean => {
    if (ts.isArrayLiteralExpression(node) && inertArray(node)) return true;
    const values = valueExpressionChildren(node);
    if (values) {
      for (const value of values) {
        budget.take(); pending.push(value);
        if (!(expressionExits(value, env) & NORMAL)) break;
      }
      return true;
    }
    if (ts.isSwitchStatement(node)) {
      const statements = statementFlow(node, env).statements;
      if (statements) { for (const statement of statements) { budget.take(); pending.push(statement); } return true; }
    }
    if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      for (const statement of statementFlow(node, env).statements ?? []) { budget.take(); pending.push(statement); }
      return true;
    }
    if (ts.isTryStatement(node)) {
      pending.push(node.tryBlock);
      if (node.catchClause && mayThrow(node.tryBlock, env)) pending.push(node.catchClause.block);
      if (node.finallyBlock) pending.push(node.finallyBlock);
      return true;
    }
    if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
      const condition = ts.isIfStatement(node) ? node.expression : node.condition;
      pending.push(condition);
      if (!(expressionExits(condition, env) & NORMAL)) return true;
      const selected = truth(condition, env);
      if (selected !== false) pending.push(ts.isIfStatement(node) ? node.thenStatement : node.whenTrue);
      const other = ts.isIfStatement(node) ? node.elseStatement : node.whenFalse;
      if (selected !== true && other) pending.push(other);
      return true;
    }
    if (ts.isVariableStatement(node) || ts.isVariableDeclarationList(node)) {
      for (const declaration of (ts.isVariableStatement(node) ? node.declarationList : node).declarations) {
        budget.take(); pending.push(declaration);
        if (!(expressionExits(declaration.initializer, env) & NORMAL)) break;
      }
      return true;
    }
    if (ts.isWhileStatement(node) || ts.isForStatement(node) || ts.isDoStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      if (ts.isForStatement(node) && node.initializer) {
        pending.push(node.initializer);
        const exits = ts.isVariableDeclarationList(node.initializer) ? statementFlow(node.initializer, env).exits : expressionExits(node.initializer, env);
        if (!(exits & NORMAL)) return true;
      }
      if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
        pending.push(node.expression);
        if (!(expressionExits(node.expression, env) & NORMAL)) return true;
        pending.push(node.statement); return true;
      }
      const condition = ts.isWhileStatement(node) || ts.isDoStatement(node) ? node.expression : node.condition;
      if (!ts.isDoStatement(node) && condition) {
        pending.push(condition);
        if (!(expressionExits(condition, env) & NORMAL) || truth(condition, env) === false) return true;
      }
      pending.push(node.statement);
      const completesIteration = statementFlow(node.statement, env).exits & (NORMAL | CONTINUE);
      if (completesIteration) {
        if (ts.isForStatement(node) && node.incrementor) pending.push(node.incrementor);
        else if (ts.isDoStatement(node)) pending.push(node.expression);
      }
      return true;
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
      pending.push(node.left);
      if (!(expressionExits(node.left, env) & NORMAL)) return true;
      const left = truth(node.left, env);
      const right = node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? left
        : node.operatorToken.kind === ts.SyntaxKind.BarBarToken ? left === undefined ? undefined : !left : nullish(node.left, env);
      if (right !== false) pending.push(node.right);
      return true;
    }
    if (ts.isBinaryExpression(node)) {
      pending.push(node.left);
      if (expressionExits(node.left, env) & NORMAL) pending.push(node.right);
      return true;
    }
    if (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const receivers: ts.Expression[] = [];
      let part: ts.Node = node;
      while (ts.isCallExpression(part) || ts.isPropertyAccessExpression(part) || ts.isElementAccessExpression(part)) {
        budget.take();
        if (part.questionDotToken) receivers.push(part.expression);
        part = part.expression;
      }
      for (let index = receivers.length - 1; index >= 0; index--) if (nullish(receivers[index], env) === true) { pending.push(receivers[index]); return true; }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      pending.push(node.expression);
      if (ts.isElementAccessExpression(node) && (simpleAccess(node.expression) || expressionExits(node.expression, env) & NORMAL)) pending.push(node.argumentExpression);
      return true;
    }
    return false;
  };
  const receiverOf = (expression: ts.Expression, env: Environment, seen = new Set<ts.Node>(), factories = false): Value | undefined => {
    if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return undefined;
    const receiver = resolve(expression.expression, env, expression.expression, seen, factories)[0];
    return receiver && ts.isNewExpression(receiver.node) ? instanceValues(receiver, seen, factories)[0] : receiver;
  };
  // Native Function helpers are safe only when the receiver is a visible
  // callable and no source declaration or escape can replace the helper.
  const nativeCallableMember = (expression: ts.PropertyAccessExpression | ts.ElementAccessExpression, env: Environment, seen = new Set<ts.Node>(), factories = true): Value[] => {
    if (definitionOf(expression) || symbolOf(expression)?.declarations?.length) return [];
    const values: Value[] = [];
    for (const value of callables(resolve(expression.expression, env, expression.expression, seen, factories))) {
      budget.take(); if (!unsafeCallables.has(value.node)) values.push(value);
    }
    return values;
  };
  const fieldAwareEnvironments = new WeakMap<Environment, boolean>();
  const fieldAware = (env: Environment): boolean => {
    const known = fieldAwareEnvironments.get(env); if (known !== undefined) return known;
    let aware = !!env.fieldPhase || !!env.receiver?.fieldOwner;
    if (!aware) for (const values of env.parameters.values()) {
      budget.take();
      if (values.some(value => { budget.take(); return !!value.fieldOwner; })) { aware = true; break; }
    }
    if (!aware && env.closure) { budget.take(); aware = fieldAware(env.closure); }
    fieldAwareEnvironments.set(env, aware); return aware;
  };
  const uninstalledFieldCall = (expression: ts.Expression, env: Environment, targets: Value[]): boolean => {
    // This proof is specific to in-progress field installation. Ordinary
    // unresolved calls (notably long aliases to Map methods) must not trigger
    // another complete binding-resolution pass on every call site.
    if (!fieldAware(env)) return false;
    if (targets.length && targets.every(value => { budget.take(); return isUndefinedValue(value); })) return true;
    if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return false;
    const key = ts.isPropertyAccessExpression(expression) ? expression.name.text : propertyName(expression.argumentExpression);
    if (!key) return false;
    const owners = resolve(expression.expression, env);
    if (!owners.length) return false;
    return owners.every(value => {
      budget.take();
      for (let fields = value.fieldOwner; fields; fields = fields.previous) {
        budget.take();
        for (const member of fields.owner.members) {
          budget.take();
          if (ts.isPropertyDeclaration(member) && propertyName(member.name) === key && !fieldInstalled(value, member)) return true;
        }
      }
      return false;
    });
  };
  const initializeFields = (owner: ts.ClassLikeDeclaration, env: Environment, request: boolean | undefined): boolean => {
    for (const member of owner.members) {
      budget.take();
      if (ts.isPropertyDeclaration(member) && member.initializer && !member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)) {
        const ready = fieldPhaseEnvironment(owner, env, member);
        enqueue({ node: member.initializer, env: ready, request });
        if (!(expressionExits(member.initializer, ready) & NORMAL)) return false;
      }
    }
    return true;
  };
  const construct = (value: Value, instance: Value, args: Value[][], request: boolean | undefined, seen = new Set<ts.Node>()): boolean => {
    budget.take();
    if (seen.has(value.node) || !ts.isClassDeclaration(value.node) && !ts.isClassExpression(value.node)) return false;
    if (seen.size > 128) throw new AnalysisLimitError("Request binding resolution depth limit exceeded");
    const next = new Set(seen).add(value.node);
    const constructor = value.node.members.find(member => { budget.take(); return ts.isConstructorDeclaration(member) && !!member.body; });
    const env: Environment = { id: nextEnvironment++, closure: value.env, parameters: new Map(), receiver: instance };
    const derived = value.node.heritageClauses?.some(heritage => { budget.take(); return heritage.token === ts.SyntaxKind.ExtendsKeyword; });
    if (constructor && callable(constructor)) {
      invoke({ node: constructor, env: value.env }, args, request, instance);
      return !!(constructorExits(value, args, instance, 0) & NORMAL);
    }
    if (!derived) return initializeFields(value.node, env, request);
    let completed = !derived;
    for (const heritage of value.node.heritageClauses ?? []) {
      budget.take();
      if (heritage.token === ts.SyntaxKind.ExtendsKeyword) for (const type of heritage.types) for (const parent of resolve(type.expression, value.env)) completed = construct(parent, instance, args, request, next) || completed;
    }
    if (derived && completed) completed = initializeFields(value.node, env, request);
    return completed;
  };
  const nativeHttpNamespace = (expression: ts.Expression, use: ts.Node, seen = new Set<ts.Node>()): boolean => {
    budget.take(); if (seen.has(expression)) return false;
    if (seen.size > 128) throw new AnalysisLimitError("Request binding resolution depth limit exceeded");
    const next = new Set(seen).add(expression);
    if (mutatedCollections.has(expression)) return false;
    if (transparent(expression)) return nativeHttpNamespace(expression.expression, use, next);
    if (ts.isIdentifier(expression)) {
      const declaration = definitionOf(expression) ?? symbolOf(expression)?.valueDeclaration ?? symbolOf(expression)?.declarations?.[0];
      if (declaration && mutatedCollections.has(declaration)) return false;
      if (declaration && ts.isVariableDeclaration(declaration)) {
        const selected = replacement(declaration, use);
        if (selected === null || uncertainBindings.has(declaration)) return false;
        if (selected ?? declaration.initializer) return nativeHttpNamespace((selected ?? declaration.initializer)!, use, next);
      }
    }
    if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === "require"
      && !symbolOf(expression.expression)?.declarations?.length && expression.arguments[0] && ts.isStringLiteralLike(expression.arguments[0])) return /^(node:)?https?$/.test(expression.arguments[0].text);
    const imported = importedBinding(expression);
    return !!imported && /^(node:)?https?$/.test(imported.module) && ["*", "default"].includes(imported.name);
  };
  const nativeFactory = (expression: ts.Expression, seen = new Set<ts.Node>(), use: ts.Node = expression): boolean => {
    budget.take(); if (seen.has(expression)) return false;
    if (seen.size > 128) throw new AnalysisLimitError("Request binding resolution depth limit exceeded");
    const next = new Set(seen).add(expression);
    if (transparent(expression)) return nativeFactory(expression.expression, next, use);
    if (ts.isIdentifier(expression)) {
      const declaration = symbolOf(expression)?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration)) {
        const selected = replacement(declaration, use);
        if (selected === null || uncertainBindings.has(declaration)) return false;
        if (selected ?? declaration.initializer) return nativeFactory((selected ?? declaration.initializer)!, next, use);
      }
    }
    const imported = importedBinding(expression);
    if (!ts.isPropertyAccessExpression(expression) && imported && /^(node:)?https?$/.test(imported.module) && ["createServer", "Server"].includes(imported.name)) return true;
    if (!ts.isPropertyAccessExpression(expression) || !["createServer", "Server"].includes(expression.name.text)) return false;
    return nativeHttpNamespace(expression.expression, use, next);
  };
  const routeReceiver = (expression: ts.Expression, env: Environment): boolean => {
    if (ts.isPropertyAccessExpression(expression)) {
      const declaration = definitionOf(expression.expression) ?? symbolOf(expression.expression)?.valueDeclaration;
      if (declaration && mutatedCollections.has(declaration)) return false;
    }
    const receiver = receiverOf(expression, env);
    if (receiver && ts.isNewExpression(receiver.node) && ts.isIdentifier(receiver.node.expression) && /^(Map|Set|WeakMap|WeakSet)$/.test(receiver.node.expression.text)) return false;
    if (!ts.isPropertyAccessExpression(expression)) return false;
    for (const object of resolve(expression.expression, env)) if (ts.isCallExpression(object.node)) {
      const imported = importedBinding(object.node.expression);
      if (imported && /^(express|fastify|koa|@koa\/router|@hapi\/hapi)$/.test(imported.module)) return true;
    }
    // Conventional names are a fallback for unresolved framework globals, not
    // evidence overriding a known local object or parameter.
    return !receiver && !definitionOf(expression.expression) && !symbolOf(expression.expression)?.declarations?.length
      && /^(app|router|server|api|fastify)$/.test(expression.expression.getText());
  };
  const poisonedCollection = (expression: ts.Expression): boolean => {
    const declaration = definitionOf(expression) ?? symbolOf(expression)?.valueDeclaration ?? symbolOf(expression)?.declarations?.[0];
    return mutatedCollections.has(expression) || !!declaration && (mutatedCollections.has(declaration) || uncertainBindings.has(declaration));
  };
  const nativeGlobal = (expression: ts.Expression, name: string): boolean => ts.isIdentifier(expression) && expression.text === name
    && !symbolOf(expression)?.declarations?.length && !mutatedCollectionGlobals.has(name);
  // Follow stable aliases without flattening arrays into a union of elements.
  // Native callbacks need the collection's shape as well as its element values.
  const collectionExpression = (expression: ts.Expression, env: Environment, seen = new Set<ts.Node>(), use: ts.Node = expression): Value | undefined => {
    budget.take(); if (seen.has(expression) || poisonedCollection(expression)) return undefined;
    if (seen.size > 128) throw new AnalysisLimitError("Request binding resolution depth limit exceeded");
    const next = new Set(seen).add(expression);
    if (transparent(expression)) return collectionExpression(expression.expression, env, next, use);
    if (ts.isElementAccessExpression(expression)) {
      const key = propertyName(expression.argumentExpression);
      if (key !== undefined && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 2 ** 32 - 1) {
        const owner = collectionExpression(expression.expression, env, next, use);
        const rest = owner && ts.isArrayLiteralExpression(owner.node) && restArrays.get(owner.node);
        const index = Number(key);
        if (rest && index < rest.spread && index < rest.items.length) {
          const values = payloadValues(rest.items[index]);
          if (values.length === 1 && ts.isExpression(values[0].node)) return collectionExpression(values[0].node, values[0].env, next, use);
        }
      }
    }
    if (ts.isIdentifier(expression)) {
      const declaration = definitionOf(expression) ?? symbolOf(expression)?.valueDeclaration;
      if (declaration && ts.isParameter(declaration)) {
        for (let current: Environment | undefined = env; current; current = current.closure) {
          budget.take(); const values = current.parameters.get(declaration);
          if (!values) continue;
          const container = collectionContainers.get(values);
          const supplied = container ?? (values.length === 1 && ts.isExpression(values[0].node) ? values[0] : undefined);
          return supplied && ts.isExpression(supplied.node) ? collectionExpression(supplied.node, supplied.env, next, use) : undefined;
        }
        return undefined;
      }
      if (declaration && ts.isVariableDeclaration(declaration)) {
        const selected = replacement(declaration, use);
        if (selected === null) return undefined;
        const value = selected ?? declaration.initializer;
        if (value) return collectionExpression(value, lexical(declaration, env), next, use);
      }
    }
    return { node: expression, env };
  };
  const undefinedValue: Value = { node: ts.factory.createVoidZero(), env: empty };
  const suppliedArguments = (fn: Value, count: number, origin: ts.Node): Value[][] => {
    const args: Value[][] = [];
    for (let index = 0; index < count; index++) {
      budget.take(); args.push([{ node: callable(fn.node) ? fn.node.parameters[index] ?? origin : origin, env: empty }]);
    }
    return args;
  };
  const collectionKind = (expression: ts.Expression, env: Environment, seen = new Set<ts.Node>(), use: ts.Node = expression): "array" | "promise" | undefined => {
    budget.take(); if (seen.has(expression)) return undefined;
    if (seen.size > 128) throw new AnalysisLimitError("Request binding resolution depth limit exceeded");
    const next = new Set(seen).add(expression);
    if (mutatedCollections.has(expression)) return undefined;
    if (transparent(expression)) return collectionKind(expression.expression, env, next, use);
    if (ts.isElementAccessExpression(expression)) {
      const selected = collectionExpression(expression, env, seen, use);
      if (selected && selected.node !== expression && ts.isExpression(selected.node)) return collectionKind(selected.node, selected.env, next, use);
    }
    if (ts.isArrayLiteralExpression(expression)) return mutatedCollectionGlobals.has("Array") ? undefined : "array";
    if (ts.isIdentifier(expression)) {
      const declaration = definitionOf(expression) ?? symbolOf(expression)?.valueDeclaration;
      if (declaration && mutatedCollections.has(declaration)) return undefined;
      if (declaration && ts.isParameter(declaration)) {
        const supplied = collectionExpression(expression, env, seen, use);
        return supplied && ts.isExpression(supplied.node) ? collectionKind(supplied.node, supplied.env, next, use) : undefined;
      }
      if (declaration && ts.isVariableDeclaration(declaration)) {
        const selected = replacement(declaration, use);
        if (selected === null || uncertainBindings.has(declaration)) return undefined;
        const value = selected ?? declaration.initializer;
        if (value) return collectionKind(value, lexical(declaration, env), next, use);
      }
    }
    const native = (value: ts.Expression, name: string) => ts.isIdentifier(value) && value.text === name && !symbolOf(value)?.declarations?.length && !mutatedCollectionGlobals.has(name);
    if (ts.isNewExpression(expression)) {
      if (native(expression.expression, "Array")) return "array";
      if (native(expression.expression, "Promise")) return "promise";
    }
    if (ts.isCallExpression(expression)) {
      const imported = importedBinding(expression.expression);
      if (imported && /^(node:)?fs$/.test(imported.module) && imported.name === "readdirSync" && !poisonedCollection(expression.expression)
        && (!ts.isPropertyAccessExpression(expression.expression) || !poisonedCollection(expression.expression.expression))) return "array";
      if (ts.isPropertyAccessExpression(expression.expression)) {
        const owner = expression.expression.expression, method = expression.expression.name.text;
        const namespace = importedBinding(owner);
        if (namespace && /^(node:)?fs$/.test(namespace.module) && ["*", "default"].includes(namespace.name) && method === "readdirSync" && !poisonedCollection(owner)) return "array";
        if (native(owner, "Array") && ["from", "of"].includes(method) || native(owner, "Object") && ["keys", "values", "entries"].includes(method)) return "array";
        if (native(owner, "Promise") && ["resolve", "reject", "all", "allSettled", "race", "any"].includes(method)) return "promise";
        const kind = collectionKind(owner, env, next, use);
        if (kind === "array" && ["map", "filter", "flatMap", "slice", "concat", "sort", "reverse", "flat"].includes(method)) return "array";
        if (kind === "promise" && ["then", "catch", "finally"].includes(method)) return "promise";
      }
      for (const value of resolve(expression.expression, env)) {
        budget.take();
        if (callable(value.node) && ts.canHaveModifiers(value.node) && ts.getModifiers(value.node)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return "promise";
      }
    }
    return undefined;
  };
  interface ArrayShape { items: Value[][]; holes: boolean[]; logicalLength?: number }
  const payloadValues = (values: Value[]): Value[] => {
    const container = collectionContainers.get(values);
    // Array resolution also serves callback registration and therefore exposes
    // its elements. A runtime payload is the array value itself, even when its
    // elements are empty, false, or undefined.
    return container ? [container] : runtimeUnions.get(values)?.values ?? values;
  };
  const arrayElements = (expression: ts.Expression, env: Environment, seen = new Set<ts.Node>()): ArrayShape | undefined => {
    budget.take(); if (seen.has(expression)) return undefined;
    if (seen.size > 128) throw new AnalysisLimitError("Request binding resolution depth limit exceeded");
    const next = new Set(seen).add(expression);
    if (ts.isArrayLiteralExpression(expression)) {
      const rest = restArrays.get(expression);
      if (rest) {
        if (rest.spread !== Infinity) return undefined;
        const items: Value[][] = [], holes: boolean[] = [];
        for (const values of rest.items) { budget.take(); items.push(payloadValues(values)); holes.push(false); }
        return { items, holes };
      }
    }
    const declaration = definitionOf(expression) ?? symbolOf(expression)?.valueDeclaration;
    if (reshapedCollections.has(expression) || !!declaration && reshapedCollections.has(declaration)) return undefined;
    const value = collectionExpression(expression, env);
    if (!value || !ts.isExpression(value.node) || reshapedCollections.has(value.node)) return undefined;
    if (ts.isArrayLiteralExpression(value.node)) {
      const rest = restArrays.get(value.node);
      if (rest) {
        if (rest.spread !== Infinity) return undefined;
        const items: Value[][] = [], holes: boolean[] = [];
        for (const values of rest.items) { budget.take(); items.push(payloadValues(values)); holes.push(false); }
        return { items, holes };
      }
    }
    if ((ts.isNewExpression(value.node) || ts.isCallExpression(value.node)) && nativeGlobal(value.node.expression, "Array")) {
      const args = value.node.arguments ?? [];
      if (!args.length) return { items: [], holes: [] };
      if (args.length === 1) {
        const count = literal(args[0], value.env);
        if (count && ts.isNumericLiteral(count)) {
          const length = Number(count.text);
          if (!Number.isInteger(length) || length < 0 || length >= 2 ** 32) return undefined;
          // One representative hole retains callback reachability without
          // allocating a runtime-sized array in the static analyzer.
          return length === 0 ? { items: [], holes: [] } : { items: [[undefinedValue]], holes: [true], logicalLength: length };
        }
      }
      const items: Value[][] = [], holes: boolean[] = [];
      for (const argument of args) { budget.take(); if (ts.isSpreadElement(argument)) return undefined; items.push(payloadValues(resolve(argument, value.env, argument, new Set(), true))); holes.push(false); }
      if (items.length === 1 && items[0].length === 1 && ts.isNumericLiteral(items[0][0].node)) {
        const length = Number(items[0][0].node.text);
        if (!Number.isInteger(length) || length < 0 || length >= 2 ** 32) return undefined;
        return length === 0 ? { items: [], holes: [] } : { items: [[undefinedValue]], holes: [true], logicalLength: length };
      }
      return { items, holes };
    }
    if (ts.isCallExpression(value.node) && ts.isPropertyAccessExpression(value.node.expression)) {
      const owner = value.node.expression.expression, method = value.node.expression.name.text;
      if (nativeGlobal(owner, "Object") && ["keys", "values", "entries"].includes(method)) {
        const source = value.node.arguments[0] && collectionExpression(value.node.arguments[0], value.env);
        if (source && ts.isObjectLiteralExpression(source.node) && source.node.properties.length === 0) return { items: [], holes: [] };
      }
      if (nativeGlobal(owner, "Array") && method === "from" && value.node.arguments[0]) {
        const source = arrayElements(value.node.arguments[0], value.env, next);
        if (source?.items.length === 0) return source;
        if (source && !value.node.arguments[1]) {
          const items: Value[][] = [], holes: boolean[] = [];
          for (let index = 0; index < source.items.length; index++) {
            budget.take(); items.push(source.holes[index] ? [undefinedValue] : source.items[index]); holes.push(false);
          }
          return { items, holes, logicalLength: source.logicalLength };
        }
        const supplied = collectionExpression(value.node.arguments[0], value.env);
        if (!mutatedCollectionGlobals.has("Object") && supplied && ts.isObjectLiteralExpression(supplied.node) && supplied.node.properties.length === 1) {
          const property = supplied.node.properties[0];
          if (ts.isPropertyAssignment(property) && propertyName(property.name) === "length") {
            const length = literal(property.initializer, supplied.env);
            if (length && ts.isNumericLiteral(length) && Number(length.text) === 0) return { items: [], holes: [] };
          }
        }
      }
      if (["map", "filter", "flatMap", "slice", "sort", "reverse", "flat"].includes(method) && collectionKind(owner, value.env) === "array") {
        const source = arrayElements(owner, value.env, next);
        if (source) {
          if (source.items.length === 0) return source;
          const holesOnly = source.holes.every(hole => { budget.take(); return hole; });
          if (holesOnly) return ["filter", "flatMap", "flat"].includes(method) ? { items: [], holes: [] } : source;
        }
      }
      return undefined;
    }
    if (!ts.isArrayLiteralExpression(value.node)) return undefined;
    const items: Value[][] = [], holes: boolean[] = [];
    for (const element of value.node.elements) {
      budget.take();
      if (ts.isSpreadElement(element)) return undefined;
      holes.push(ts.isOmittedExpression(element));
      const values = ts.isOmittedExpression(element) ? [undefinedValue] : payloadValues(resolve(element, value.env, element, new Set(), true));
      items.push(values.length ? values : [{ node: element, env: value.env }]);
    }
    return { items, holes };
  };
  const emptyArrayLike = (expression: ts.Expression, env: Environment): boolean => {
    if (mutatedCollectionGlobals.has("Object")) return false;
    const value = collectionExpression(expression, env);
    if (!value || !ts.isObjectLiteralExpression(value.node) || value.node.properties.length !== 1) return false;
    const property = value.node.properties[0];
    if (!ts.isPropertyAssignment(property) || propertyName(property.name) !== "length") return false;
    const length = literal(property.initializer, value.env);
    return !!length && ts.isNumericLiteral(length) && Number(length.text) === 0;
  };
  const promiseResult = (expression: ts.Expression, env: Environment): { state: "fulfilled" | "rejected" | "unknown"; payload: Value[] } => {
    const value = collectionExpression(expression, env);
    if (!value || !ts.isCallExpression(value.node) || !ts.isPropertyAccessExpression(value.node.expression)
      || !nativeGlobal(value.node.expression.expression, "Promise")) return { state: "unknown", payload: [] };
    const method = value.node.expression.name.text;
    const argument = value.node.arguments[0];
    const payload = argument ? payloadValues(resolve(argument, value.env)) : [undefinedValue];
    if (method === "reject") return { state: "rejected", payload };
    if (method !== "resolve") return { state: "unknown", payload: [] };
    const actual = argument && collectionExpression(argument, value.env);
    const primitive = !argument || !!actual && (ts.isStringLiteralLike(actual.node) || ts.isNumericLiteral(actual.node)
      || ts.isVoidExpression(actual.node) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(actual.node.kind)
      || ts.isIdentifier(actual.node) && actual.node.text === "undefined" && !symbolOf(actual.node)?.declarations?.length);
    return { state: primitive ? "fulfilled" : "unknown", payload };
  };
  const nativeCallbackReceiver = (node: ts.CallExpression | ts.NewExpression, env: Environment): { index: number; callbacks: Value[] } | undefined => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
    const method = node.expression.name.text;
    if (CALLBACK_METHODS.has(method) && !["reduce", "reduceRight", "sort", "then", "catch", "finally"].includes(method) && collectionKind(node.expression.expression, env) === "array") {
      return { index: 1, callbacks: resolve(node.arguments[0], env) };
    }
    if (nativeGlobal(node.expression.expression, "Array") && method === "from") return { index: 2, callbacks: resolve(node.arguments[1], env) };
    return undefined;
  };
  const nativeCallbackArguments = (node: ts.CallExpression | ts.NewExpression, env: Environment): number[] => {
    budget.take();
    if (ts.isNewExpression(node)) return nativeGlobal(node.expression, "Promise") ? [0] : [];
    if (!ts.isPropertyAccessExpression(node.expression)) return [];
    const method = node.expression.name.text, owner = node.expression.expression;
    if (nativeGlobal(owner, "Array") && method === "from") return [1];
    const kind = collectionKind(owner, env);
    if (kind === "array" && !mutatedCollectionGlobals.has("Array") && CALLBACK_METHODS.has(method) && !["then", "catch", "finally"].includes(method)) return [0];
    if (kind === "promise" && !mutatedCollectionGlobals.has("Promise") && ["then", "catch", "finally"].includes(method)) return method === "then" ? [0, 1] : [0];
    return [];
  };
  // A known reduction is ordered: the accumulator is the preceding callback's
  // result, not the union of every collection element. Keep each possible
  // callback identity separate so one reducer cannot donate another's result.
  const invokeReduction = (node: ts.CallExpression | ts.NewExpression, env: Environment, args: Value[][], request: boolean | undefined, shape: ArrayShape, right: boolean, depth = 0, schedule = true): number => {
    budget.take(); completionDepth(depth);
    const indices: number[] = [];
    for (let index = 0; index < shape.items.length; index++) { budget.take(); if (!shape.holes[index]) indices.push(index); }
    if (right) { budget.take(indices.length); indices.reverse(); }
    const hasInitial = (node.arguments?.length ?? 0) > 1;
    let callbackExits = 0;
    const suppliedCallbacks = args[0] ?? [];
    const callbackContainer = collectionContainers.get(suppliedCallbacks);
    const callbacks = callbackContainer ? [callbackContainer] : runtimeUnions.get(suppliedCallbacks)?.values ?? suppliedCallbacks;
    if (!callbacks.length) callbackExits = !node.arguments?.length || collectionContainers.has(callbacks) ? THROW : NORMAL | THROW;
    for (const fn of callbacks) {
      budget.take();
      callbackExits |= callable(fn.node) || ts.isClassDeclaration(fn.node) || ts.isClassExpression(fn.node) ? NORMAL
        : ts.isObjectLiteralExpression(fn.node) || ts.isArrayLiteralExpression(fn.node) || ts.isNumericLiteral(fn.node) || ts.isStringLiteralLike(fn.node)
          || isUndefinedValue(fn) || [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(fn.node.kind) ? THROW : NORMAL | THROW;
    }
    if (!(callbackExits & NORMAL)) return THROW;
    const compactDense = (shape.logicalLength ?? shape.items.length) > shape.items.length && indices.length > 0;
    // A compact dense shape represents many values, not one exact iteration.
    // Completion stays uncertain; evidence uses two bounded representatives
    // so a missing initial accumulator does not erase all callback execution.
    if (compactDense && !schedule) return NORMAL | THROW;
    if (compactDense && indices.length === 1) {
      budget.take(3); indices.length = 0;
      const length = shape.logicalLength!;
      indices.push(right ? length - 1 : 0, right ? length - 2 : 1);
    }
    if (!indices.length) return hasInitial ? callbackExits : THROW;
    if (!hasInitial && indices.length < 2) return callbackExits;
    const container = ts.isPropertyAccessExpression(node.expression) ? collectionExpression(node.expression.expression, env) : undefined;
    let exits = callbackExits & THROW;
    if (!callbacks.length) return NORMAL | THROW;
    for (const fn of callbacks) {
      budget.take();
      let path = NORMAL;
      let accumulator = hasInitial ? payloadValues(args[1] ?? []) : compactDense ? shape.items[0] : shape.items[indices[0]];
      // An unresolved supplied value remains opaque; it is not a missing
      // argument selecting a reducer parameter's default.
      if (!accumulator.length) accumulator = [{ node, env }];
      for (let position = hasInitial ? 0 : 1; position < indices.length; position++) {
        budget.take();
        const index = indices[position];
        const callbackArgs = [accumulator, compactDense ? shape.items[0] : shape.items[index], [{ node: ts.factory.createNumericLiteral(index), env: empty }], container ? [container] : [{ node, env }]];
        if (!callable(fn.node)) {
          const knownNonCallable = ts.isClassDeclaration(fn.node) || ts.isClassExpression(fn.node) || ts.isObjectLiteralExpression(fn.node) || ts.isArrayLiteralExpression(fn.node)
            || ts.isNumericLiteral(fn.node) || ts.isStringLiteralLike(fn.node) || isUndefinedValue(fn) || [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(fn.node.kind);
          path = knownNonCallable ? THROW : path | THROW;
          if (knownNonCallable) break;
          accumulator = [{ node, env }]; continue;
        }
        let supplied = callbackArgs, receiver: Value | undefined;
        if (fn.bound) { budget.take(fn.bound.args.length + callbackArgs.length); supplied = [...fn.bound.args, ...callbackArgs]; receiver = fn.bound.receiver; }
        const inner = bind(fn, supplied, receiver);
        const asynchronous = !fn.node.asteriskToken && fn.node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword);
        // Schedule default-initializer effects with the original arguments,
        // then recover their values in that same parameter scope. Defaults
        // are evaluated before a reducer body and can themselves throw.
        const entry = defaultExits(fn.node, supplied, inner, depth + 1, request, schedule);
        if (!asynchronous) path = (path & THROW) | entry;
        if (!(entry & NORMAL)) { if (asynchronous) { accumulator = [{ node, env }]; continue; } break; }
        budget.take(supplied.length); supplied = supplied.slice();
        for (let parameterIndex = 0; parameterIndex < fn.node.parameters.length; parameterIndex++) {
          budget.take(); const parameter = fn.node.parameters[parameterIndex];
          if (!parameter.initializer || !takesDefault(supplied[parameterIndex])) continue;
          const initialized: Value[] = [];
          for (const value of supplied[parameterIndex] ?? []) { budget.take(); if (!undefinedArgument(value)) append(initialized, [value]); }
          const defaults = payloadValues(resolve(parameter.initializer, inner, parameter.initializer, new Set(), true));
          append(initialized, defaults.length ? defaults : [{ node: parameter.initializer, env: inner }]);
          supplied[parameterIndex] = initialized; inner.parameters.set(parameter, initialized);
        }
        if (schedule) invoke(fn.bound ? { ...fn, bound: undefined } : fn, supplied, request, receiver);
        if (fn.node.asteriskToken || asynchronous) { accumulator = [{ node, env }]; continue; }
        const returned: Value[] = [];
        if (ts.isBlock(fn.node.body)) {
          const flow = statementFlow(fn.node.body, inner, depth + 1);
          path = (path & THROW) | (flow.exits & THROW) | (flow.exits & (NORMAL | RETURN) ? NORMAL : 0);
          if (!(path & NORMAL)) break;
          for (const statement of flow.returns) {
            budget.take();
            const values = statement.expression ? payloadValues(resolve(statement.expression, inner, statement.expression, new Set(), true)) : [undefinedValue];
            append(returned, values.length ? values : [{ node: statement, env: inner }]);
          }
          if (flow.exits & NORMAL) append(returned, [undefinedValue]);
        } else {
          const bodyExits = expressionExits(fn.node.body, inner, depth + 1);
          path = (path & THROW) | bodyExits;
          if (!(path & NORMAL)) break;
          append(returned, payloadValues(resolve(fn.node.body, inner, fn.node.body, new Set(), true)));
        }
        accumulator = returned.length ? returned : [{ node, env }];
      }
      exits |= path;
    }
    return compactDense ? exits | NORMAL | THROW : exits;
  };
  const reductionResults = new Map<string, CompletionSummary<number>>();
  const activeReductions = new Set<ts.CallExpression>();
  // Native reductions can fail before the surrounding handler continues. Keep
  // completion separate from evidence scheduling, with the same checked depth
  // summaries used for ordinary callable completion.
  const reductionCompletion = (node: ts.CallExpression, env: Environment, args: Value[][], depth: number): number | undefined => {
    budget.take(); completionDepth(depth);
    if (!ts.isPropertyAccessExpression(node.expression) || !["reduce", "reduceRight"].includes(node.expression.name.text)
      || mutatedCollectionGlobals.has("Array") || collectionKind(node.expression.expression, env) !== "array") return undefined;
    for (const argument of node.arguments) { budget.take(); if (ts.isSpreadElement(argument)) return undefined; }
    const shape = arrayElements(node.expression.expression, env);
    if (!shape) return undefined;
    if (activeReductions.has(node)) return NORMAL | THROW;
    if (node.arguments[0]) {
      budget.take(args.length); args = args.slice();
      args[0] = resolve(node.arguments[0], env, node.arguments[0], new Set(), true);
      if (node.arguments[1]) args[1] = payloadValues(resolve(node.arguments[1], env, node.arguments[1], new Set(), true));
    }
    const key = `${id(node)}:${env.id}:${argumentSignature(args)}:${initializationSignature()}`;
    const known = reductionResults.get(key);
    if (known) return reuseCompletion(known, depth);
    activeReductions.add(node);
    const frame = startCompletion(depth);
    try {
      const exits = invokeReduction(node, env, args, undefined, shape, node.expression.name.text === "reduceRight", depth + 1, false);
      reductionResults.set(key, completionSummary(exits, frame));
      return exits;
    } finally { finishCompletion(frame); activeReductions.delete(node); }
  };
  const invokeExternalCallbacks = (node: ts.CallExpression | ts.NewExpression, env: Environment, args: Value[][], request: boolean, plans?: WeakMap<ts.Node, ConstructorInvocation[]>): void => {
    const expression = node.expression;
    if (plans) {
      const scheduled = new Set<ConstructorInvocation[]>();
      for (const values of args) for (const value of values) {
        budget.take(); const entries = plans.get(value.node);
        if (entries && !scheduled.has(entries)) { scheduled.add(entries); invokeConstructorEntries(entries, request); }
      }
      if (scheduled.size) return;
    }
    if (ts.isNewExpression(node) && nativeGlobal(expression, "Promise")) {
      for (const value of args[0] ?? []) { budget.take(); invoke(value, suppliedArguments(value, 2, node), request, undefined); }
      return;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      if (nativeGlobal(expression.expression, "Array") && expression.name.text === "from") {
        const source = node.arguments?.[0];
        const shape = source && (arrayElements(source, env) ?? (emptyArrayLike(source, env) ? { items: [], holes: [] } : undefined));
        if (shape && shape.items.length === 0) return;
        const payload: Value[] = [];
        if (shape) for (const values of shape.items) append(payload, values);
        for (const value of args[1] ?? []) {
          budget.take(); const callbackArgs = suppliedArguments(value, 2, node);
          if (shape) callbackArgs[0] = payload;
          for (const receiver of explicitReceivers(args[2])) { budget.take(); invoke(value, callbackArgs, request, receiver); }
        }
        return;
      }
      const kind = collectionKind(expression.expression, env);
      const method = expression.name.text;
      const arrayMethod = kind === "array" && !mutatedCollectionGlobals.has("Array") && CALLBACK_METHODS.has(method) && !["then", "catch", "finally"].includes(method);
      const promiseMethod = kind === "promise" && !mutatedCollectionGlobals.has("Promise") && ["then", "catch", "finally"].includes(method);
      if (arrayMethod || promiseMethod) {
        const shape = arrayMethod ? arrayElements(expression.expression, env) : undefined;
        const visitsHoles = ["find", "findIndex"].includes(method);
        const payload: Value[] = [];
        if (shape) for (let index = 0; index < shape.items.length; index++) {
          budget.take(); if (!shape.holes[index] || visitsHoles) append(payload, shape.items[index]);
        }
        const reducing = ["reduce", "reduceRight"].includes(method);
        if (reducing && shape) { invokeReduction(node, env, args, request, shape, method === "reduceRight"); return; }
        if (shape && (!payload.length || method === "sort" && shape.items.length < 2 || reducing && !node.arguments?.[1] && shape.items.filter((_, index) => { budget.take(); return !shape.holes[index]; }).length < 2)) return;
        const promise = promiseMethod ? promiseResult(expression.expression, env) : undefined;
        const positions = method === "then" ? promise?.state === "fulfilled" ? [0] : promise?.state === "rejected" ? [1] : [0, 1]
          : method === "catch" && promise?.state === "fulfilled" ? [] : [0];
        const supplied = promiseMethod ? method === "finally" ? 0 : 1 : method === "sort" ? 2 : ["reduce", "reduceRight"].includes(method) ? 4 : 3;
        for (const position of positions) for (const value of args[position] ?? []) {
          budget.take();
          // Native callbacks receive arguments; an unavailable payload is not
          // proof of a missing argument that should execute its default.
          const callbackArgs = suppliedArguments(value, supplied, node);
          if (promiseMethod && supplied && promise?.state !== "unknown") callbackArgs[0] = promise!.payload;
          if (arrayMethod && shape) {
            if (reducing) { callbackArgs[0] = args[1]?.length ? args[1] : payload; callbackArgs[1] = payload; }
            else { callbackArgs[0] = payload; if (method === "sort") callbackArgs[1] = payload; }
          }
          if (arrayMethod && method !== "sort") {
            const container = collectionExpression(expression.expression, env);
            if (container) callbackArgs[reducing ? 3 : 2] = [container];
          }
          const receivers = arrayMethod && !reducing && method !== "sort" ? explicitReceivers(args[1]) : [undefined];
          for (const receiver of receivers) { budget.take(); invoke(value, callbackArgs, request, receiver, undefined, promiseMethod); }
        }
        return;
      }
    }
    // Method spelling alone cannot establish callback execution. In particular
    // an unknown `.map` is not necessarily Array.prototype.map.
    for (const values of args) for (const value of values) { budget.take(); invoke(value, [], false, undefined); }
  };
  const roots = (node: ts.CallExpression | ts.NewExpression, env: Environment): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ROUTE_METHODS.has(node.expression.name.text)
      && !node.arguments.some(argument => resolve(argument, env, argument, new Set(), true).some(value => { budget.take(); return callable(value.node) || ts.isObjectLiteralExpression(value.node); }))) return;
    let values: Value[] = [], certainty = true, supplied = 3;
    if (nativeFactory(node.expression)) {
      supplied = 2;
      const first = resolve(node.arguments?.[0], env, node.arguments?.[0], new Set(), true);
      if (first.some(value => { budget.take(); return callable(value.node); })) append(values, first);
      else append(values, resolve(node.arguments?.[1], env, node.arguments?.[1], new Set(), true));
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (ROUTE_METHODS.has(method) && routeReceiver(node.expression, env)) {
        for (const owner of resolve(node.expression.expression, env)) {
          budget.take();
          if (ts.isCallExpression(owner.node) && importedBinding(owner.node.expression)?.module === "fastify") supplied = 2;
        }
        if (method === "route" && node.arguments[0]) {
          supplied = 2;
          for (const object of resolve(node.arguments[0], env, node.arguments[0], new Set(), true)) if (ts.isObjectLiteralExpression(object.node)) append(values, resolve(members(object.node).get("handler"), object.env, object.node, new Set(), true));
        } else for (const argument of node.arguments) append(values, resolve(argument, env, argument, new Set(), true));
      }
      if (["on", "once", "addListener"].includes(method) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === "request") {
        const receiver = receiverOf(node.expression, env);
        const native = receiver && (ts.isCallExpression(receiver.node) || ts.isNewExpression(receiver.node)) && nativeFactory(receiver.node.expression);
        if (native || !receiver && /^(server|httpServer)$/.test(node.expression.expression.getText())) {
          supplied = 2;
          certainty = !!native;
          for (const argument of node.arguments.slice(1)) append(values, resolve(argument, env, argument, new Set(), true));
        }
      }
    }
    for (const value of values) invoke(value, suppliedArguments(value, supplied, node), certainty);
  };
  const poisonCollection = (expression: ts.Expression, seen = new Set<ts.Node>()): void => {
    budget.take(); if (seen.has(expression)) return;
    if (seen.size > 128) throw new AnalysisLimitError("Request binding resolution depth limit exceeded");
    const next = new Set(seen).add(expression);
    mutatedCollections.add(expression);
    if (transparent(expression)) { poisonCollection(expression.expression, next); return; }
    if (ts.isIdentifier(expression)) {
      if (["Array", "Promise", "Object"].includes(expression.text) && !symbolOf(expression)?.declarations?.length) mutatedCollectionGlobals.add(expression.text);
      const declaration = definitionOf(expression) ?? symbolOf(expression)?.valueDeclaration ?? symbolOf(expression)?.declarations?.[0];
      if (declaration) {
        mutatedCollections.add(declaration);
        if (ts.isVariableDeclaration(declaration) && declaration.initializer) poisonCollection(declaration.initializer, next);
      }
    } else if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) poisonCollection(expression.expression, next);
  };
  const reshapeCollection = (expression: ts.Expression, seen = new Set<ts.Node>()): void => {
    budget.take(); if (seen.has(expression)) return;
    if (seen.size > 128) throw new AnalysisLimitError("Request binding resolution depth limit exceeded");
    const next = new Set(seen).add(expression);
    reshapedCollections.add(expression);
    if (transparent(expression)) reshapeCollection(expression.expression, next);
    else if (ts.isIdentifier(expression)) {
      const declaration = definitionOf(expression) ?? symbolOf(expression)?.valueDeclaration;
      if (declaration) {
        reshapedCollections.add(declaration);
        if (ts.isVariableDeclaration(declaration) && declaration.initializer) reshapeCollection(declaration.initializer, next);
      }
    }
  };
  // Index writes before resolving any call, then collect potential request
  // registrations even inside an exported server factory not called locally.
  const propertyWriteDeclaration = (expression: ts.Expression, name: string, seen = new Set<ts.Node>(), instance = false): ts.Declaration | undefined => {
    budget.take(); if (seen.has(expression)) return undefined;
    if (seen.size > 128) throw new AnalysisLimitError("Request binding resolution depth limit exceeded");
    const next = new Set(seen).add(expression);
    if (transparent(expression)) return propertyWriteDeclaration(expression.expression, name, next, instance);
    if (ts.isNewExpression(expression)) return propertyWriteDeclaration(expression.expression, name, next, true);
    const declaration = definitionOf(expression) ?? symbolOf(expression)?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
      && ts.isVariableDeclarationList(declaration.parent) && declaration.parent.flags & ts.NodeFlags.Const) {
      return propertyWriteDeclaration(declaration.initializer, name, next, instance);
    }
    if (!declaration || !ts.isClassDeclaration(declaration) && !ts.isClassExpression(declaration)) return undefined;
    for (const member of declaration.members) {
      budget.take();
      const isStatic = !!(ts.canHaveModifiers(member) && ts.getModifiers(member)?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword));
      if ((ts.isPropertyDeclaration(member) || ts.isMethodDeclaration(member)) && propertyName(member.name) === name && isStatic !== instance) return writeDeclaration(member);
    }
    for (const clause of declaration.heritageClauses ?? []) if (clause.token === ts.SyntaxKind.ExtendsKeyword) for (const type of clause.types) {
      const found = propertyWriteDeclaration(type.expression, name, next, instance); if (found) return found;
    }
    return undefined;
  };
  for (const { sf } of workspace.units) {
    const pending: ts.Node[] = [sf];
    while (pending.length) {
      budget.take(); const node = pending.pop()!;
      const assignment = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
      const target = assignment ? node.left : ts.isDeleteExpression(node) ? node.expression
        : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) ? node.operand : undefined;
      if (target && (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))) poisonCollection(target.expression);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ["push", "pop", "splice", "shift", "unshift", "copyWithin", "fill"].includes(node.expression.name.text)) reshapeCollection(node.expression.expression);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["assign", "defineProperty", "defineProperties", "setPrototypeOf"].includes(node.expression.name.text)
        && ts.isIdentifier(node.expression.expression) && ["Object", "Reflect"].includes(node.expression.expression.text)
        && !symbolOf(node.expression.expression)?.declarations?.length && node.arguments[0]) poisonCollection(node.arguments[0]);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const key = ts.isPropertyAccessExpression(node.left) ? node.left.name.text : ts.isElementAccessExpression(node.left) ? propertyName(node.left.argumentExpression) : undefined;
        const rawDeclaration = symbolOf(node.left)?.valueDeclaration ?? (key !== undefined && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
          ? propertyWriteDeclaration(node.left.expression, key) : undefined);
        const declaration = rawDeclaration && writeDeclaration(rawDeclaration);
        if (declaration) {
          const values = writes.get(declaration) ?? [];
          const scope = enclosing(node);
          const statement = ts.isExpressionStatement(node.parent) ? node.parent : undefined;
          let initialization: ts.Node = node;
          while (initialization.parent && transparent(initialization.parent)) { budget.take(); initialization = initialization.parent; }
          const fieldWrite = ts.isPropertyDeclaration(initialization.parent) && initialization.parent.initializer === initialization;
          const staticWrite = !!statement && ts.isBlock(statement.parent) && ts.isClassStaticBlockDeclaration(statement.parent.parent);
          const definite = fieldWrite || staticWrite || !!statement && (ts.isSourceFile(statement.parent) || ts.isBlock(statement.parent) && statement.parent.parent === scope);
          values.push({ value: node.right, node, scope, definite }); writes.set(declaration, values); if (definite) definiteWrites.add(node);
        }
      }
      ts.forEachChild(node, child => { pending.push(child); });
    }
  }
  for (const values of writes.values()) values.sort((a, b) => { budget.take(); return a.node.pos - b.node.pos; });
  stableResolutionPhase = true;
  // Registration discovery has a narrower graph than request execution. A
  // module's CLI/library helpers need not be simulated merely to find an HTTP
  // factory hidden behind another statically called setup helper.
  const callers = new Map<ts.Node, Set<ts.Node>>();
  const setupCalls: Array<ts.CallExpression | ts.NewExpression> = [];
  const markRegistrationEvaluation = (node: ts.Node): void => {
    for (let current: ts.Node | undefined = node; current && !ts.isFunctionLike(current); current = current.parent) {
      budget.take(); registrationEvaluation.add(current);
      if (ts.isSourceFile(current)) break;
    }
  };
  const directFunction = (node: ts.Node | undefined): ts.Node | undefined => {
    if (!node) return undefined;
    if (callable(node)) return node;
    if (ts.isVariableDeclaration(node) && node.initializer && callable(node.initializer)) return node.initializer;
    return undefined;
  };
  for (const { sf } of workspace.units) {
    const pending: ts.Node[] = [sf];
    while (pending.length) {
      budget.take(); const node = pending.pop()!;
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        setupCalls.push(node);
        const owner = enclosing(node);
        const expression = node.expression;
        const method = ts.isPropertyAccessExpression(expression) ? expression.name.text : undefined;
        const registration = !!owner && (nativeFactory(expression)
          || !!method && ROUTE_METHODS.has(method) && routeReceiver(expression, empty)
          || !!method && ["on", "once", "addListener"].includes(method) && !!node.arguments?.[0] && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === "request");
        if (owner && registration) registrationCandidates.add(owner);
        if (registration) markRegistrationEvaluation(node);
        else if (!owner) {
          const method = ts.isPropertyAccessExpression(expression) ? expression.name.text : undefined;
          const possibleRoute = !!method && ROUTE_METHODS.has(method) && !!node.arguments?.some(argument => {
            const values = resolve(argument, empty);
            return values.some(value => { budget.take(); return callable(value.node) || ts.isObjectLiteralExpression(value.node); });
          });
          if (nativeFactory(expression) || possibleRoute && routeReceiver(expression, empty)
            || !!method && ["on", "once", "addListener"].includes(method) && !!node.arguments?.[0] && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === "request") markRegistrationEvaluation(node);
        }
        const callee = directFunction(definitionOf(expression));
        if (owner && callee) { const known = callers.get(callee) ?? new Set(); known.add(owner); callers.set(callee, known); }
      }
      ts.forEachChild(node, child => { pending.push(child); });
    }
  }
  const registrationQueue = [...registrationCandidates];
  while (registrationQueue.length) {
    budget.take(); const fn = registrationQueue.pop()!;
    for (const caller of callers.get(fn) ?? []) { budget.take(); if (!registrationCandidates.has(caller)) { registrationCandidates.add(caller); registrationQueue.push(caller); } }
  }
  for (const call of setupCalls) {
    budget.take();
    const owner = enclosing(call);
    if (owner && registrationCandidates.has(owner)) { markRegistrationEvaluation(call); continue; }
    const declaration = definitionOf(call.expression);
    const direct = directFunction(declaration);
    if (direct && registrationCandidates.has(direct)) { markRegistrationEvaluation(call); continue; }
    if (declaration && ts.isClassDeclaration(declaration) && declaration.members.some(member => { budget.take(); return ts.isConstructorDeclaration(member) && registrationCandidates.has(member); })) markRegistrationEvaluation(call);
    else if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
      && (ts.isIdentifier(declaration.initializer) || ts.isCallExpression(declaration.initializer))) {
      for (const value of resolve(call.expression, empty)) {
        budget.take(); if (callable(value.node) && registrationCandidates.has(value.node)) { markRegistrationEvaluation(call); break; }
      }
    }
  }
  // Receiver mutation/escape is separate from method bodies. A normal `this`
  // read or helper call is not a mutation, while writes/unknown consumers must
  // not recover a stale method solely from the original property symbol.
  const markUnsafe = (expression: ts.Node): void => {
    const resolved = resolve(expression, empty);
    const container = collectionContainers.get(resolved);
    budget.take(resolved.length + (container ? 1 : 0));
    const pending = container ? [container, ...resolved] : [...resolved];
    const declaration = definitionOf(expression);
    const allocation = pending.some(value => { budget.take(); return ts.isObjectLiteralExpression(value.node) || ts.isArrayLiteralExpression(value.node) || ts.isNewExpression(value.node) || ts.isClassDeclaration(value.node) || ts.isClassExpression(value.node) || ts.isCallExpression(value.node); });
    if (allocation && declaration && (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration))) uncertainBindings.add(declaration);
    const seen = new Set<ts.Node>();
    while (pending.length) {
      budget.take(); const value = pending.pop()!;
      if (seen.has(value.node)) continue; seen.add(value.node);
      if (callable(value.node)) unsafeCallables.add(value.node);
      if (ts.isObjectLiteralExpression(value.node) || ts.isClassDeclaration(value.node) || ts.isClassExpression(value.node)) {
        unsafeReceivers.add(value.node);
        if (ts.isObjectLiteralExpression(value.node)) for (const property of value.node.properties) {
          budget.take();
          if (ts.isPropertyAssignment(property)) append(pending, resolve(property.initializer, value.env));
          else if (ts.isShorthandPropertyAssignment(property)) append(pending, resolve(property.name, value.env));
          else if (ts.isSpreadAssignment(property)) append(pending, resolve(property.expression, value.env));
        }
      } else if (ts.isNewExpression(value.node)) {
        for (const constructor of resolve(value.node.expression, value.env)) {
          budget.take();
          if (ts.isClassDeclaration(constructor.node) || ts.isClassExpression(constructor.node)) unsafeReceivers.add(constructor.node);
        }
      } else if (ts.isArrayLiteralExpression(value.node)) {
        mutatedCollections.add(value.node);
        for (const element of value.node.elements) append(pending, resolve(ts.isSpreadElement(element) ? element.expression : element, value.env));
      }
    }
  };
  const consumerSafety = new WeakMap<Callable, Map<ts.ParameterDeclaration, boolean>>();
  const accumulatorConsumerSafety = new WeakMap<Callable, Map<ts.ParameterDeclaration, boolean>>();
  const consumerReferences = new WeakMap<Callable, Map<ts.Declaration, ts.Identifier[]>>();
  const referencesFor = (fn: Callable): Map<ts.Declaration, ts.Identifier[]> => {
    const known = consumerReferences.get(fn); if (known) return known;
    const references = new Map<ts.Declaration, ts.Identifier[]>(), pending: ts.Node[] = [fn.body];
    while (pending.length) {
      budget.take(); const node = pending.pop()!;
      if (ts.isIdentifier(node) && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)) {
        const declaration = definitionOf(node);
        if (declaration) { const uses = references.get(declaration) ?? []; uses.push(node); references.set(declaration, uses); }
      }
      ts.forEachChild(node, child => { pending.push(child); });
    }
    consumerReferences.set(fn, references); return references;
  };
  const receiverSafety = new WeakMap<Callable, boolean>();
  const readsOnlyThis = (fn: Callable): boolean => {
    const known = receiverSafety.get(fn);
    if (known !== undefined) return known;
    receiverSafety.set(fn, false);
    const pending: ts.Node[] = [fn.body];
    while (pending.length) {
      budget.take(); const node = pending.pop()!;
      if (node.kind === ts.SyntaxKind.ThisKeyword) {
        let use: ts.Node = node;
        while (use.parent && (transparent(use.parent) && use.parent.expression === use
          || (ts.isPropertyAccessExpression(use.parent) || ts.isElementAccessExpression(use.parent)) && use.parent.expression === use)) {
          budget.take(); use = use.parent;
        }
        const parent = use.parent;
        if (!(parent && ts.isCallExpression(parent) && parent.expression === use && use !== node)) return false;
      }
      ts.forEachChild(node, child => { pending.push(child); });
    }
    receiverSafety.set(fn, true); return true;
  };
  const readsOnly = (fn: Callable, parameter: ts.ParameterDeclaration, depth = 0, unchangedReturn = false): boolean => {
    budget.take(); if (depth > 128) throw new AnalysisLimitError("Request binding resolution depth limit exceeded");
    const cache = unchangedReturn ? accumulatorConsumerSafety : consumerSafety;
    const known = cache.get(fn) ?? new Map<ts.ParameterDeclaration, boolean>();
    if (known.has(parameter)) return known.get(parameter)!;
    known.set(parameter, false); cache.set(fn, known);
    const references = referencesFor(fn);
    const active = new Set<ts.Declaration>();
    const safeBinding = (binding: ts.Declaration, aliasDepth = depth): boolean => {
      if (aliasDepth > 128) throw new AnalysisLimitError("Request binding resolution depth limit exceeded");
      budget.take(); if (active.has(binding)) return false;
      active.add(binding);
      try {
      for (const node of references.get(binding) ?? []) {
        budget.take();
        let use: ts.Node = node;
        while (use.parent && (transparent(use.parent) && use.parent.expression === use
          || (ts.isPropertyAccessExpression(use.parent) || ts.isElementAccessExpression(use.parent)) && use.parent.expression === use)) {
          budget.take(); use = use.parent;
        }
        const parent = use.parent;
        const receiverCall = parent && ts.isCallExpression(parent) && parent.expression === use && use !== node
          && !(ts.isPropertyAccessExpression(use) && ["push", "pop", "shift", "unshift", "splice", "copyWithin", "fill", "sort", "reverse"].includes(use.name.text));
        const capturedAlias = parent && ts.isVariableDeclaration(parent) && parent.initializer === use
          && ts.isIdentifier(parent.name) && !!(parent.parent.flags & ts.NodeFlags.Const) && safeBinding(parent, aliasDepth + 1);
        const guard = parent && (ts.isIfStatement(parent) && parent.expression === use || ts.isConditionalExpression(parent) && parent.condition === use);
        let forwarded = false;
        if (parent && ts.isCallExpression(parent) && parent.expression !== use) {
          const index = parent.arguments.findIndex(argument => { budget.take(); return argument === use; });
          if (index >= 0) {
            const consumers = callables(resolve(parent.expression, empty));
            forwarded = consumers.length > 0 && consumers.every(value => {
              budget.take(); const target = value.node as Callable;
              return !target.parameters[index] || readsOnly(target, target.parameters[index], aliasDepth + 1);
            });
          }
        }
        let direct = use;
        while (transparent(direct)) { budget.take(); direct = direct.expression; }
        const returned = unchangedReturn && direct === node && (ts.isReturnStatement(parent) && parent.expression === use
          || ts.isArrowFunction(parent) && parent.body === use);
        if (!receiverCall && !capturedAlias && !guard && !forwarded && !returned && !ts.isExpressionStatement(parent)) return false;
      }
      return true;
      } finally { active.delete(binding); }
    };
    if (!safeBinding(parameter)) return false;
    known.set(parameter, true); return true;
  };
  const reducerArgumentsSafety = new WeakMap<Callable, boolean>();
  const observesInvocationArguments = (fn: Callable): boolean => {
    const known = reducerArgumentsSafety.get(fn); if (known !== undefined) return known;
    const pending: ts.Node[] = [fn.body];
    while (pending.length) {
      budget.take(); const node = pending.pop()!;
      if (node !== fn.body && ts.isFunctionLike(node) && !ts.isArrowFunction(node)) continue;
      if (ts.isIdentifier(node) && node.text === "arguments" && !symbolOf(node)?.declarations?.length) { reducerArgumentsSafety.set(fn, true); return true; }
      ts.forEachChild(node, child => { pending.push(child); });
    }
    reducerArgumentsSafety.set(fn, false); return false;
  };
  const safeReducerAccumulator = (node: ts.CallExpression | ts.NewExpression, env: Environment): boolean => {
    budget.take();
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)
      || !["reduce", "reduceRight"].includes(node.expression.name.text) || mutatedCollectionGlobals.has("Array")
      || collectionKind(node.expression.expression, env) !== "array" || !node.arguments[0]) return false;
    const supplied = resolve(node.arguments[0], env, node.arguments[0], new Set(), true);
    const callbacks = collectionContainers.has(supplied) ? [] : runtimeUnions.get(supplied)?.values ?? supplied;
    if (!callbacks.length) return false;
    for (const value of callbacks) {
      budget.take();
      if (!callable(value.node) || !ts.isArrowFunction(value.node) && observesInvocationArguments(value.node)) return false;
      const position = value.bound?.args.length ?? 0;
      for (let index = 0; index <= position && index < value.node.parameters.length; index++) { budget.take(); if (value.node.parameters[index].dotDotDotToken) return false; }
      const parameter = value.node.parameters[position];
      if (!parameter) continue;
      if (parameter.dotDotDotToken || !ts.isIdentifier(parameter.name) || !readsOnly(value.node, parameter, 0, true)) return false;
    }
    return true;
  };
  // Consumer unions are shared by immutable binding resolution. The same
  // argument position must not rescan every callable at every call site.
  const argumentConsumerSafety = new WeakMap<Value[], Map<number, { length: number; safe: boolean }>>();
  const safeConsumerArgument = (consumers: Value[], index: number): boolean => {
    budget.take();
    if (!consumers.length) return false;
    const positions = argumentConsumerSafety.get(consumers) ?? new Map<number, { length: number; safe: boolean }>();
    const known = positions.get(index);
    if (known && known.length <= consumers.length && (!known.safe || known.length === consumers.length)) return known.safe;
    let safe = true;
    for (let cursor = known && known.length <= consumers.length ? known.length : 0; cursor < consumers.length; cursor++) {
      budget.take(); const fn = consumers[cursor].node as Callable;
      const parameter = fn.parameters[index];
      if (parameter && !readsOnly(fn, parameter)) { safe = false; break; }
    }
    positions.set(index, { length: consumers.length, safe }); argumentConsumerSafety.set(consumers, positions);
    return safe;
  };
  for (const { sf } of workspace.units) {
    const pending: ts.Node[] = [sf];
    while (pending.length) {
      budget.take(); const node = pending.pop()!;
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && (node.arguments ?? []).some(argument => {
        const values = resolve(ts.isSpreadElement(argument) ? argument.expression : argument, empty);
        return collectionContainers.has(values) || values.some(value => {
        budget.take(); return callable(value.node) || ts.isObjectLiteralExpression(value.node) || ts.isArrayLiteralExpression(value.node) || ts.isNewExpression(value.node) || ts.isClassDeclaration(value.node) || ts.isClassExpression(value.node) || ts.isCallExpression(value.node);
        });
      })) {
        const registered = nativeFactory(node.expression) || ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && ROUTE_METHODS.has(node.expression.name.text) && routeReceiver(node.expression, empty);
        const consumers = callables(resolve(node.expression, empty));
        const helper = ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))
          && ["call", "bind"].includes(ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : propertyName(node.expression.argumentExpression) ?? "")
          ? nativeCallableMember(node.expression, empty) : [];
        const callbackReceiver = nativeCallbackReceiver(node, empty);
        const callbackArguments = nativeCallbackArguments(node, empty);
        const safeAccumulator = safeReducerAccumulator(node, empty);
        const nativeArrayInput = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && nativeGlobal(node.expression.expression, "Array") && node.expression.name.text === "from"
          && !mutatedCollectionGlobals.has("Array");
        (node.arguments ?? []).forEach((argument, index) => {
          // Native callback consumers invoke the supplied function without
          // changing its own Function helper properties. Passing a bound
          // function here must not poison its underlying callable identity.
          const safe = registered || callbackArguments.includes(index) || index === 1 && safeAccumulator || index === 0 && helper.length > 0 && helper.every(value => { budget.take(); return readsOnlyThis(value.node as Callable); })
            || index === 0 && nativeArrayInput && collectionContainers.has(resolve(argument, empty))
            || callbackReceiver && index === callbackReceiver.index && callbackReceiver.callbacks.length > 0 && callbackReceiver.callbacks.every(value => { budget.take(); return callable(value.node) && readsOnlyThis(value.node); })
            || safeConsumerArgument(consumers, index);
          if (!safe) markUnsafe(ts.isSpreadElement(argument) ? argument.expression : argument);
        });
      }
      const assignment = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
      const target = assignment ? node.left : ts.isDeleteExpression(node) ? node.expression
        : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) ? node.operand : undefined;
      if (node.kind === ts.SyntaxKind.ThisKeyword && ts.isCallExpression(node.parent) && node.parent.arguments.some(argument => argument === node)) {
        for (let owner: ts.Node | undefined = node.parent; owner; owner = owner.parent) {
          budget.take();
          if (ts.isObjectLiteralExpression(owner) || ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) { unsafeReceivers.add(owner); break; }
        }
      }
      if (ts.isObjectLiteralExpression(node) && node.properties.some(property => { budget.take(); return ts.isGetAccessor(property) || ts.isSetAccessor(property); })) markUnsafe(node);
      if (target && (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))) {
        if (target.expression.kind === ts.SyntaxKind.ThisKeyword) {
          for (let owner: ts.Node | undefined = target.parent; owner; owner = owner.parent) {
            budget.take();
            if (ts.isObjectLiteralExpression(owner) || ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) { unsafeReceivers.add(owner); break; }
          }
        } else if (!assignment || !definiteWrites.has(node)) markUnsafe(target.expression);
      }
      ts.forEachChild(node, child => { pending.push(child); });
    }
  }
  stableResolutionPhase = true;
  for (const { sf, rel } of workspace.units) {
    enqueue({ node: sf, env: empty });
    const pending: ts.Node[] = [sf];
    while (pending.length) {
      budget.take(); const node = pending.pop()!;
      if (evaluatedChildren(node, empty, pending)) continue;
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const evaluation = callEvaluation(node, empty, registrationEvaluation.has(node));
        if (evaluation.invokes) roots(node, empty);
        for (const child of evaluation.children) { budget.take(); pending.push(child); }
        continue;
      }
      if (callable(node)) {
        const variable = ts.isVariableDeclaration(node.parent) ? node.parent : undefined;
        const name = node.name ? propertyName(node.name) : variable && ts.isIdentifier(variable.name) ? variable.name.text : undefined;
        const statement = variable?.parent.parent;
        const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
        const exported = !!modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
          || !!statement && ts.isVariableStatement(statement) && !!statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
          || ts.isExportAssignment(node.parent);
        const signature = node.parameters.length >= 2 && /^(req|request)$/.test(node.parameters[0].name.getText()) && /^(res|response|reply)$/.test(node.parameters[1].name.getText());
        const verb = name && HTTP_VERBS.has(name) && exported && /(^|\/)(app|pages|api|routes?)(\/|\.)/i.test(rel);
        const nest = ts.canHaveDecorators(node) && ts.getDecorators(node)?.some(decorator => {
          const expression = ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression;
          const imported = importedBinding(expression);
          return imported?.module === "@nestjs/common" && /^(Get|Post|Put|Patch|Delete|Head|Options|All)$/.test(imported.name);
        });
        if (signature && exported && /(^|\/)(app|pages|api|routes?)(\/|\.)/i.test(rel) || verb || nest) {
          const entry = { node, env: empty };
          const supplied = nest ? node.parameters.length : verb || /(^|\/)pages\//i.test(rel) ? 2 : 3;
          invoke(entry, suppliedArguments(entry, supplied, node), true, nest && (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent)) ? { node: node.parent, env: empty } : undefined);
        }
        // A private, uncalled server factory is not evidence of a request
        // entry. Exported factories remain potential external entry points.
        if (!exported) continue;
        invoke({ node, env: empty }, []);
        // Bodies are entered through bound request/setup invocations. Walking
        // every exported library body here would simulate unrelated CLI and
        // analysis helpers merely to discover an HTTP registration.
        continue;
      }
      ts.forEachChild(node, child => { pending.push(child); });
    }
  }
  while (work.length) {
    const task = work.pop()!;
    const previousInitializations = new Map(activeInitializations);
    activeInitializations.clear();
    for (const [owner, state] of task.initializations ?? []) { budget.take(); activeInitializations.set(owner, state); }
    try {
    const pending: ts.Node[] = [task.node];
    while (pending.length) {
      budget.take(); const node = pending.pop()!;
      if (ts.isFunctionLike(node)) continue;
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        for (const member of node.members) if (ts.isClassStaticBlockDeclaration(member)) pending.push(member.body);
        continue;
      }
      if (evaluatedChildren(node, task.env, pending)) continue;
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const permitted = constructorInvocations.get(task.env);
        if (permitted && !permitted.calls.has(node)) continue;
        const evaluation = callEvaluation(node, task.env, task.request !== undefined || registrationEvaluation.has(node));
        if (!evaluation.invokes) {
          for (const child of evaluation.children) { budget.take(); pending.push(child); }
          continue;
        }
        roots(node, task.env);
        if (ts.isCallExpression(node) && task.request !== undefined) evidence.set(node, !!evidence.get(node) || task.request);
        const targets = resolve(node.expression, task.env, node.expression, new Set(), task.request !== undefined);
        let functions = callables(targets);
        let args = (node.arguments ?? []).map(argument => resolve(argument, task.env, argument, new Set(), task.request !== undefined));
        let receiver = receiverOf(node.expression, task.env, new Set(), task.request !== undefined);
        let knownHelper = false;
        let callReceivers: Array<Value | undefined> | undefined;
        if (ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
          const method = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : propertyName(node.expression.argumentExpression);
          if (method === "call" || method === "bind") {
            const originals = nativeCallableMember(node.expression, task.env);
            if (originals.length) {
              knownHelper = true;
              functions = method === "call" ? originals : [];
              if (method === "call") callReceivers = explicitReceivers(args[0]);
              receiver = undefined; args = args.slice(1);
            }
          }
        }
        const scheduledPlans = new Set<ConstructorInvocation[]>();
        for (const fn of functions) {
          const paired = !knownHelper && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) ? fn.memberReceiver ?? receiver : receiver;
          const entries = permitted?.targets.get(node)?.get(fn.node);
          if (entries) {
            if (!scheduledPlans.has(entries)) { scheduledPlans.add(entries); invokeConstructorEntries(entries, task.request); }
            continue;
          }
          if (callReceivers) for (const target of callReceivers) { budget.take(); invoke(fn, args, task.request, target); }
          else invoke(fn, args, task.request, paired);
        }
        let constructor = false;
        if (ts.isNewExpression(node)) for (const target of targets) {
          budget.take();
          if (ts.isClassDeclaration(target.node) || ts.isClassExpression(target.node)) {
            constructor = true; construct(target, { node, env: task.env }, args, task.request);
          }
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
          for (let scope: Environment | undefined = task.env; scope; scope = scope.closure) {
            budget.take();
            if (!scope.fn || !ts.isConstructorDeclaration(scope.fn) || !scope.receiver) continue;
            const owner = scope.fn.parent;
            let completed = false;
            for (const heritage of owner.heritageClauses ?? []) if (heritage.token === ts.SyntaxKind.ExtendsKeyword) {
              for (const type of heritage.types) for (const parent of resolve(type.expression, scope)) completed = construct(parent, scope.receiver, args, task.request) || completed;
            }
            if (completed) initializeFields(owner, scope, task.request);
            constructor = true; break;
          }
        }
        if (task.request !== undefined && !functions.length && !knownHelper && !constructor) {
          invokeExternalCallbacks(node, task.env, args, task.request, constructorInvocations.get(task.env)?.targets.get(node));
        }
        for (const child of evaluation.children) { budget.take(); pending.push(child); }
        continue;
      }
      ts.forEachChild(node, child => { pending.push(child); });
    }
    } finally {
      activeInitializations.clear();
      for (const [owner, state] of previousInitializations) { budget.take(); activeInitializations.set(owner, state); }
    }
  }
  return { evidence: node => evidence.has(node) ? evidence.get(node) ? "request" : "possible" : undefined };
}
