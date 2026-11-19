import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeFindings } from "../dist/findings.js";

function finding(id, file = "server.ts", line = 1, message = "finding") {
  return { id, file, line, message, category: "DB", severity: "medium", confidence: "high",
    snippet: "", scaleTrigger: "", suggestedFix: "" };
}

test("large detector output merges without an argument-count ceiling", () => {
  const rows = Array.from({ length: 140_000 }, (_, index) => finding("test", "server.ts", index + 1));
  const merged = mergeFindings([rows, rows]);
  assert.equal(merged.length, rows.length);
  assert.equal(merged[0], rows[0]);
  assert.equal(merged.at(-1), rows.at(-1));
});

test("read suppression is local to the matching N+1 location and independent of detector order", () => {
  const n1 = finding("n-plus-one", "a.ts", 3);
  const duplicateRead = finding("unbounded-read", "a.ts", 3);
  const otherLine = finding("unbounded-read", "a.ts", 4);
  const otherFile = finding("unbounded-read", "b.ts", 3);
  const write = finding("floating-promise", "a.ts", 3);
  assert.deepEqual(mergeFindings([[duplicateRead, otherLine, otherFile, write], [n1, n1]]),
    [otherLine, otherFile, write, n1]);
  assert.deepEqual(mergeFindings([[n1], [duplicateRead, otherLine, otherFile, write]]),
    [n1, otherLine, otherFile, write]);
});

test("delimiter characters cannot merge distinct findings", () => {
  const first = finding("test", "lib.ts|3", 2, "message");
  const second = finding("test", "lib.ts", 3, "2|message");
  assert.deepEqual(mergeFindings([[first, second], [{ ...first }]]), [first, second]);
});

test("many overlapping read findings use linear source-location work", () => {
  const count = 20_000;
  let locationReads = 0;
  const rows = id => Array.from({ length: count }, (_, index) => ({
    ...finding(id, "server.ts", index + 1),
    get file() { locationReads++; return "server.ts"; },
  }));
  const merged = mergeFindings([rows("unbounded-read"), rows("n-plus-one")]);
  assert.equal(merged.length, count);
  assert.ok(merged.every(row => row.id === "n-plus-one"));
  assert.ok(locationReads <= count * 6, `unexpected repeated source-location work: ${locationReads}`);
});

test("the strongest evidence at a duplicate site survives in either traversal order", () => {
  const low = { ...finding("sync-io"), severity: "medium", confidence: "high" };
  const high = { ...low, severity: "high", confidence: "low" };
  const confirmed = { ...high, confidence: "medium", scaleTrigger: "request entry" };
  for (const rows of [[low, high, confirmed], [confirmed, high, low], [high, low, confirmed]]) {
    assert.deepEqual(mergeFindings([rows]), [confirmed]);
  }
  assert.equal(mergeFindings([[{ ...high, column: 4 }, { ...low, column: 45 }]]).length, 2);
});
