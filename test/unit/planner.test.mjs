import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlannerOutput, plan } from "../../lib/planner.mjs";

test("parsePlannerOutput accepts plain JSON", () => {
  const r = parsePlannerOutput('{"subgoals":[{"id":"sg-1","title":"a"}]}');
  assert.equal(r.subgoals.length, 1);
});

test("parsePlannerOutput accepts JSON inside markdown fences", () => {
  const r = parsePlannerOutput('```json\n{"subgoals":[{"id":"sg-1"}]}\n```');
  assert.equal(r.subgoals[0].id, "sg-1");
});

test("parsePlannerOutput accepts JSON after prose", () => {
  const r = parsePlannerOutput('Here is the plan: {"subgoals":[{"id":"sg-2"}]}');
  assert.equal(r.subgoals[0].id, "sg-2");
});

test("parsePlannerOutput returns null on garbage", () => {
  assert.equal(parsePlannerOutput("no json here at all"), null);
  assert.equal(parsePlannerOutput(""), null);
  assert.equal(parsePlannerOutput(null), null);
  assert.equal(parsePlannerOutput(undefined), null);
});

test("plan() in mock mode returns single-subgoal degenerate", async () => {
  process.env.AGENC_GOAL_MOCK = "1";
  delete process.env.AGENC_GOAL_MOCK_PLANNER;
  try {
    const r = await plan("Write a sentence about cats");
    assert.equal(r.subgoals.length, 1);
    assert.equal(r.subgoals[0].id, "sg-1");
    assert.match(r.subgoals[0].description, /cats/);
  } finally {
    delete process.env.AGENC_GOAL_MOCK;
  }
});

test("normalize() breaks dependency cycles", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const dir = await mkdtemp(path.join(os.tmpdir(), "agenc-cycle-"));
  const fixture = path.join(dir, "p.json");
  await writeFile(fixture, JSON.stringify({
    subgoals: [
      { id: "a", title: "A", description: "a", done_criteria: "x", depends_on: ["b"] },
      { id: "b", title: "B", description: "b", done_criteria: "x", depends_on: ["a"] },
    ],
  }));
  process.env.AGENC_GOAL_MOCK = "1";
  process.env.AGENC_GOAL_MOCK_PLANNER = fixture;
  try {
    const r = await plan("test");
    assert.equal(r.subgoals.length, 2);
    // Cycle broken: at least one node should have lost its dependency.
    const allDeps = r.subgoals.flatMap(sg => sg.depends_on);
    assert.ok(allDeps.length < 2, `expected cycle to be broken, got deps: ${JSON.stringify(allDeps)}`);
  } finally {
    delete process.env.AGENC_GOAL_MOCK;
    delete process.env.AGENC_GOAL_MOCK_PLANNER;
    await rm(dir, { recursive: true, force: true });
  }
});

test("plan() with mock fixture file returns full subgoal list", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const dir = await mkdtemp(path.join(os.tmpdir(), "agenc-plan-"));
  const fixture = path.join(dir, "planner.json");
  try {
    await writeFile(fixture, JSON.stringify({
      subgoals: [
        { id: "a", title: "First", description: "do a", done_criteria: "x", depends_on: [] },
        { id: "b", title: "Second", description: "do b", done_criteria: "y", depends_on: ["a"] },
      ],
    }));
    process.env.AGENC_GOAL_MOCK = "1";
    process.env.AGENC_GOAL_MOCK_PLANNER = fixture;
    const r = await plan("multi-step");
    assert.equal(r.subgoals.length, 2);
    assert.equal(r.subgoals[0].id, "sg-1");
    assert.equal(r.subgoals[1].id, "sg-2");
    assert.deepEqual(r.subgoals[1].depends_on, ["sg-1"]);
  } finally {
    delete process.env.AGENC_GOAL_MOCK;
    delete process.env.AGENC_GOAL_MOCK_PLANNER;
    await rm(dir, { recursive: true, force: true });
  }
});
