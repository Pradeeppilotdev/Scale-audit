import ts from "typescript";
import type { AnalysisBudget } from "./analysisBudget.js";

interface ConditionValue {
  truth: boolean | null;
  // Undefined means the result type is unknown, not that it is non-Boolean.
  boolean?: boolean;
  nullish?: boolean;
}

const unknown: ConditionValue = { truth: null };
const valuesByBudget = new WeakMap<AnalysisBudget, WeakMap<ts.Expression, ConditionValue>>();

/** Exact Boolean value on normal completion, distinct from mere truthiness. */
export function conditionBoolean(node: ts.Expression, budget: AnalysisBudget): boolean | undefined {
  conditionTruth(node, budget);
  const value = valuesByBudget.get(budget)?.get(node);
  return value?.boolean === true ? value.truth ?? undefined : undefined;
}

/** Nullishness on normal completion, independent of a Boolean's truth value. */
export function conditionNullish(node: ts.Expression, budget: AnalysisBudget): boolean | undefined {
  conditionTruth(node, budget);
  return valuesByBudget.get(budget)?.get(node)?.nullish;
}

/** Truth on normal completion. Callers still evaluate the operands for effects. */
export function conditionTruth(node: ts.Expression, budget: AnalysisBudget): boolean | undefined {
  let memo = valuesByBudget.get(budget);
  const known = memo?.get(node);
  if (known) return known.truth ?? undefined;
  if (!memo) { memo = new WeakMap(); valuesByBudget.set(budget, memo); }
  const pending = [node];
  while (pending.length) {
    budget.take();
    const expression = pending[pending.length - 1];
    let result = unknown;
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)
      || ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression)
      || ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
      const wrapped = ts.isPrefixUnaryExpression(expression) ? expression.operand : expression.expression;
      const value = memo.get(wrapped);
      if (!value) { pending.push(wrapped); continue; }
      result = ts.isPrefixUnaryExpression(expression)
        ? { truth: value.truth === null ? null : !value.truth, boolean: true, nullish: false } : value;
    } else if (ts.isConditionalExpression(expression)) {
      const condition = memo.get(expression.condition);
      if (!condition) { pending.push(expression.condition); continue; }
      if (condition.truth !== null) {
        const selected = condition.truth ? expression.whenTrue : expression.whenFalse;
        const value = memo.get(selected);
        if (!value) { pending.push(selected); continue; }
        result = value;
      } else {
        const yes = memo.get(expression.whenTrue), no = memo.get(expression.whenFalse);
        if (!yes) { pending.push(expression.whenTrue); continue; }
        if (!no) { pending.push(expression.whenFalse); continue; }
        result = {
          truth: yes.truth === no.truth ? yes.truth : null,
          boolean: yes.boolean === no.boolean ? yes.boolean : undefined,
          nullish: yes.nullish === no.nullish ? yes.nullish : undefined,
        };
      }
    } else if (ts.isBinaryExpression(expression) && (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      const decisive = expression.operatorToken.kind === ts.SyntaxKind.BarBarToken;
      const left = memo.get(expression.left);
      if (!left) { pending.push(expression.left); continue; }
      if (left.truth === decisive) result = left;
      else {
        const right = memo.get(expression.right);
        if (!right) { pending.push(expression.right); continue; }
        result = left.truth !== null ? right : {
          truth: right.truth === decisive ? decisive : null,
          boolean: left.boolean === right.boolean ? left.boolean : undefined,
          nullish: left.nullish === right.nullish ? left.nullish : undefined,
        };
      }
    } else if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      const left = memo.get(expression.left);
      if (!left) { pending.push(expression.left); continue; }
      if (left.nullish === false || left.truth === true) result = left;
      else {
        const right = memo.get(expression.right);
        if (!right) { pending.push(expression.right); continue; }
        result = left.nullish === true ? right : {
          truth: left.truth === right.truth ? left.truth : null,
          boolean: left.boolean === right.boolean ? left.boolean : undefined,
          nullish: right.nullish === false ? false : undefined,
        };
      }
    } else if (ts.isBinaryExpression(expression) && (expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      || expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)) {
      const left = memo.get(expression.left), right = memo.get(expression.right);
      if (!left) { pending.push(expression.left); continue; }
      if (!right) { pending.push(expression.right); continue; }
      const fixed = left.boolean === true && left.truth !== null ? left
        : right.boolean === true && right.truth !== null ? right : undefined;
      const compared = fixed === left ? right : left;
      let equal: boolean | null = null;
      if (fixed) {
        // Truthiness alone cannot prove equality to true or false. It can
        // disprove it, and a known Boolean result makes the match exact.
        if (compared.boolean === false || compared.truth !== null && compared.truth !== fixed.truth) equal = false;
        else if (compared.boolean === true && compared.truth !== null) equal = true;
      }
      result = { truth: equal === null || expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        ? equal : !equal, boolean: true, nullish: false };
    } else if (ts.isBinaryExpression(expression) && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken,
      ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.InKeyword, ts.SyntaxKind.InstanceOfKeyword].includes(expression.operatorToken.kind)) {
      result = { truth: null, boolean: true, nullish: false };
    } else if (expression.kind === ts.SyntaxKind.TrueKeyword) result = { truth: true, boolean: true, nullish: false };
    else if (expression.kind === ts.SyntaxKind.FalseKeyword) result = { truth: false, boolean: true, nullish: false };
    else if (expression.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(expression)) result = { truth: false, boolean: false, nullish: true };
    else if (ts.isNumericLiteral(expression)) result = { truth: Number(expression.text) !== 0, boolean: false, nullish: false };
    else if (ts.isStringLiteralLike(expression)) result = { truth: expression.text.length !== 0, boolean: false, nullish: false };
    memo.set(expression, result);
    pending.pop();
  }
  return memo.get(node)?.truth ?? undefined;
}
