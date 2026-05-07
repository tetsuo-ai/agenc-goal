import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVerdict, review } from "../../lib/reviewer.mjs";

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

test("review() in mock mode returns canned APPROVED by default", async () => {
  process.env.AGENC_GOAL_MOCK = "1";
  delete process.env.AGENC_GOAL_MOCK_REVIEWER;
  try {
    const r = await review({
      objective: "x",
      subgoal: { title: "t", description: "d", done_criteria: "c" },
      diff: "",
      gate_results: [],
    });
    assert.equal(r.verdict, "APPROVED");
  } finally {
    delete process.env.AGENC_GOAL_MOCK;
  }
});

test("review() in mock mode honors AGENC_GOAL_MOCK_REVIEWER override", async () => {
  process.env.AGENC_GOAL_MOCK = "1";
  process.env.AGENC_GOAL_MOCK_REVIEWER = "NEEDS_REVISION";
  try {
    const r = await review({
      objective: "x",
      subgoal: { title: "t", description: "d", done_criteria: "c" },
      diff: "",
      gate_results: [],
    });
    assert.equal(r.verdict, "NEEDS_REVISION");
  } finally {
    delete process.env.AGENC_GOAL_MOCK;
    delete process.env.AGENC_GOAL_MOCK_REVIEWER;
  }
});
