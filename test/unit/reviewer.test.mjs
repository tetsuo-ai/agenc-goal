import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewPayload,
  parseVerdict,
  extractReasoning,
  normalizeSubmittedVerdict,
} from "../../lib/reviewer.mjs";

test("parseVerdict accepts each valid verdict on the last line", () => {
  assert.equal(parseVerdict("Reasoning text\n\nVERDICT: APPROVED"), "APPROVED");
  assert.equal(parseVerdict("Issues with auth\nVERDICT: NEEDS_REVISION"), "NEEDS_REVISION");
  assert.equal(parseVerdict("Cannot proceed\nVERDICT: BLOCKED"), "BLOCKED");
});

test("parseVerdict accepts trailing whitespace on the verdict line", () => {
  assert.equal(parseVerdict("VERDICT: APPROVED   "), "APPROVED");
  assert.equal(parseVerdict("VERDICT: APPROVED\n\n"), "APPROVED");
});

test("parseVerdict rejects unknown verdict words", () => {
  assert.equal(parseVerdict("VERDICT: SOMETHING_ELSE"), null);
  assert.equal(parseVerdict("VERDICT: ok"), null);
});

test("parseVerdict rejects when verdict is older than the last 5 non-empty lines", () => {
  assert.equal(parseVerdict("VERDICT: APPROVED\nA\nB\nC\nD\nE"), null);
});

test("parseVerdict accepts VERDICT line within last 5 non-empty lines", () => {
  assert.equal(parseVerdict("VERDICT: APPROVED\n```"), "APPROVED");
  assert.equal(parseVerdict("VERDICT: APPROVED\n\n\n\n```\n```"), "APPROVED");
  assert.equal(parseVerdict("VERDICT: APPROVED\nA\nB\nC\nD\nE\nF"), null);
});

test("parseVerdict returns null on missing verdict", () => {
  assert.equal(parseVerdict("just some prose"), null);
  assert.equal(parseVerdict(""), null);
  assert.equal(parseVerdict(null), null);
});

test("extractReasoning strips the verdict line", () => {
  const r = extractReasoning("Some reasoning here.\n\nVERDICT: APPROVED");
  assert.equal(r, "Some reasoning here.");
});

test("extractReasoning returns empty string on null/empty input", () => {
  assert.equal(extractReasoning(null), "");
  assert.equal(extractReasoning(""), "");
  assert.equal(extractReasoning(undefined), "");
});

test("buildReviewPayload includes objective, subgoal fields, and diff", () => {
  const p = buildReviewPayload({
    objective: "ship the thing",
    subgoal: { title: "T", description: "D", done_criteria: "C" },
    diff: "diff content here",
    gate_results: [],
  });
  assert.match(p, /Top objective: ship the thing/);
  assert.match(p, /- Title: T/);
  assert.match(p, /- Description: D/);
  assert.match(p, /- Done criteria: C/);
  assert.match(p, /diff content here/);
});

test("buildReviewPayload notes when no gates are configured", () => {
  const p = buildReviewPayload({
    objective: "x",
    subgoal: { title: "t", description: "d", done_criteria: "c" },
    diff: "",
    gate_results: [],
  });
  assert.match(p, /\(no gates configured for this project\)/);
});

test("buildReviewPayload formats PASS and FAIL gates differently", () => {
  const p = buildReviewPayload({
    objective: "x",
    subgoal: { title: "t", description: "d", done_criteria: "c" },
    diff: "",
    gate_results: [
      { name: "tests", cmd: "npm test", exit: 0, ms: 100, stdout: "ok", stderr: "" },
      { name: "lint", cmd: "npm run lint", exit: 1, ms: 50, stdout: "", stderr: "fail!" },
    ],
  });
  assert.match(p, /\[PASS\] tests/);
  assert.match(p, /\[FAIL\] lint/);
  assert.match(p, /stderr:\nfail!/);
});

test("buildReviewPayload truncates oversized diffs", () => {
  // The default cap is 200KB; 300KB definitely exceeds it regardless of env.
  const big = "x".repeat(300 * 1024);
  const p = buildReviewPayload({
    objective: "x",
    subgoal: { title: "t", description: "d", done_criteria: "c" },
    diff: big,
    gate_results: [],
  });
  assert.match(p, /\[diff truncated/);
});

test("normalizeSubmittedVerdict accepts explicit verdict + reasoning", () => {
  const r = normalizeSubmittedVerdict({ verdict: "APPROVED", reasoning: "looks good" });
  assert.deepEqual(r, { verdict: "APPROVED", reasoning: "looks good" });
});

test("normalizeSubmittedVerdict normalizes case and trims whitespace", () => {
  const r = normalizeSubmittedVerdict({ verdict: "  approved  " });
  assert.equal(r.verdict, "APPROVED");
});

test("normalizeSubmittedVerdict rejects unknown verdict strings", () => {
  assert.equal(normalizeSubmittedVerdict({ verdict: "MAYBE" }), null);
  assert.equal(normalizeSubmittedVerdict({ verdict: "" }), null);
});

test("normalizeSubmittedVerdict parses verdict from reviewer_output", () => {
  const r = normalizeSubmittedVerdict({
    reviewer_output: "Detailed reasoning paragraph here.\n\nVERDICT: NEEDS_REVISION",
  });
  assert.equal(r.verdict, "NEEDS_REVISION");
  assert.match(r.reasoning, /Detailed reasoning/);
});

test("normalizeSubmittedVerdict returns null when reviewer_output has no parseable verdict", () => {
  assert.equal(normalizeSubmittedVerdict({ reviewer_output: "just prose, no verdict" }), null);
});

test("normalizeSubmittedVerdict returns null on empty/garbage args", () => {
  assert.equal(normalizeSubmittedVerdict(null), null);
  assert.equal(normalizeSubmittedVerdict({}), null);
  assert.equal(normalizeSubmittedVerdict("not an object"), null);
});

test("normalizeSubmittedVerdict prefers explicit verdict over reviewer_output", () => {
  const r = normalizeSubmittedVerdict({
    verdict: "BLOCKED",
    reasoning: "stuck",
    reviewer_output: "VERDICT: APPROVED",
  });
  assert.equal(r.verdict, "BLOCKED");
});
