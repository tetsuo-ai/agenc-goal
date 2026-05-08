import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePlannerOutput,
  resolveSubgoals,
  normalize,
  breakCycles,
  singletonSubgoal,
} from "../../lib/planner.mjs";

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

test("resolveSubgoals accepts an array directly", () => {
  const r = resolveSubgoals([{ id: "x", title: "X" }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].id, "x");
});

test("resolveSubgoals returns null for an empty array", () => {
  assert.equal(resolveSubgoals([]), null);
});

test("resolveSubgoals parses a JSON string of {subgoals: [...]}", () => {
  const r = resolveSubgoals('{"subgoals":[{"id":"sg-1","title":"a"}]}');
  assert.equal(r.length, 1);
});

test("resolveSubgoals parses a bare JSON array string", () => {
  const r = resolveSubgoals('[{"id":"sg-1","title":"a"}]');
  assert.equal(r.length, 1);
});

test("resolveSubgoals accepts an object with a subgoals key", () => {
  const r = resolveSubgoals({ subgoals: [{ id: "sg-1", title: "a" }] });
  assert.equal(r.length, 1);
});

test("resolveSubgoals handles raw subagent text with JSON inside prose", () => {
  const text = "Here is my plan:\n\n" +
    '{"subgoals":[{"id":"a","title":"first","description":"d","done_criteria":"c","depends_on":[]}]}\n\n' +
    "Done.";
  const r = resolveSubgoals(text);
  assert.equal(r.length, 1);
  assert.equal(r[0].id, "a");
});

test("resolveSubgoals returns null on unparseable input", () => {
  assert.equal(resolveSubgoals("totally not json"), null);
  assert.equal(resolveSubgoals(null), null);
  assert.equal(resolveSubgoals(undefined), null);
  assert.equal(resolveSubgoals(42), null);
});

test("normalize remaps original ids to sg-N and rewires deps", () => {
  const out = normalize(
    [
      { id: "a", title: "First", description: "do a", done_criteria: "x", depends_on: [] },
      { id: "b", title: "Second", description: "do b", done_criteria: "y", depends_on: ["a"] },
    ],
    "test",
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].id, "sg-1");
  assert.equal(out[1].id, "sg-2");
  assert.deepEqual(out[1].depends_on, ["sg-1"]);
});

test("normalize fills missing fields with degenerate defaults", () => {
  const out = normalize([{}], "Be excellent to each other");
  assert.equal(out[0].id, "sg-1");
  assert.equal(out[0].title, "Subgoal 1");
  assert.equal(out[0].description, "Be excellent to each other");
  assert.match(out[0].done_criteria, /User confirms/);
  assert.deepEqual(out[0].depends_on, []);
});

test("normalize truncates very long fields", () => {
  const longTitle = "x".repeat(500);
  const longDesc = "y".repeat(2000);
  const longDone = "z".repeat(800);
  const out = normalize(
    [{ id: "a", title: longTitle, description: longDesc, done_criteria: longDone }],
    "test",
  );
  assert.equal(out[0].title.length, 200);
  assert.equal(out[0].description.length, 1000);
  assert.equal(out[0].done_criteria.length, 500);
});

test("breakCycles clears edges of any subgoal participating in a cycle", () => {
  const subgoals = [
    { id: "sg-1", depends_on: ["sg-2"] },
    { id: "sg-2", depends_on: ["sg-1"] },
  ];
  breakCycles(subgoals);
  // Cycle broken: at least one node should have lost its dependency.
  const allDeps = subgoals.flatMap(sg => sg.depends_on);
  assert.ok(allDeps.length < 2, `expected cycle to be broken, got deps: ${JSON.stringify(allDeps)}`);
});

test("breakCycles preserves all subgoals", () => {
  const subgoals = [
    { id: "sg-1", depends_on: ["sg-2"] },
    { id: "sg-2", depends_on: ["sg-1"] },
    { id: "sg-3", depends_on: [] },
  ];
  breakCycles(subgoals);
  assert.equal(subgoals.length, 3);
});

test("singletonSubgoal builds a v0.1-style fallback record", () => {
  const sg = singletonSubgoal("Do the thing");
  assert.equal(sg.id, "sg-1");
  assert.equal(sg.title, "Do the thing");
  assert.equal(sg.description, "Do the thing");
  assert.match(sg.done_criteria, /User confirms/);
  assert.deepEqual(sg.depends_on, []);
});

test("singletonSubgoal truncates an overlong objective into the title", () => {
  const longObj = "a".repeat(200);
  const sg = singletonSubgoal(longObj);
  assert.equal(sg.title.length, 80);
  assert.equal(sg.description.length, 200); // description keeps full text
});
