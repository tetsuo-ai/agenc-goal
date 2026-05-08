#!/usr/bin/env node
// On session resume, restore the active goal (and its current subgoal,
// if any) into context so the model picks up where it left off.

import process from "node:process";
import { loadDb } from "../lib/db.mjs";
import { untrusted } from "../lib/text.mjs";

async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

const raw = await readStdin();
let input;
try {
  input = JSON.parse(raw || "{}");
} catch {
  process.exit(0);
}

const cwd = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

let db;
try {
  db = await loadDb();
} catch {
  process.exit(0);
}

const goal = db.goals?.[cwd];
if (!goal || goal.status === "complete") {
  process.exit(0);
}

const elapsed = Math.floor((Date.now() - new Date(goal.created_at).getTime()) / 1000);

if (!goal.subgoals?.length) {
  const additionalContext = [
    `## Active goal in this project`,
    ``,
    `Objective: ${untrusted(goal.objective)}`,
    `Status: ${goal.status}`,
    `Elapsed: ${elapsed}s.`,
    ``,
    `Continue working toward this objective. Call goal_update with status="complete" when achieved.`,
  ].join("\n");

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
  }));
  process.exit(0);
}

const total = goal.subgoals.length;
const done = goal.subgoals.filter((sg) => sg.status === "complete").length;
const active = goal.subgoals.find((sg) => sg.status === "in_progress");
const reviewPending = goal.subgoals.find((sg) => sg.status === "review_pending");
const blocked = goal.subgoals.find((sg) => sg.status === "blocked");

const subgoalLines = goal.subgoals.map((sg, i) => {
  const glyph = { pending: " ", in_progress: "~", review_pending: "?", complete: "x", blocked: "!" }[sg.status] || "?";
  return `  [${glyph}] ${sg.id}: ${untrusted(sg.title)}`;
});

let activeBlock;
if (reviewPending) {
  activeBlock = [
    ``,
    `### Awaiting review: ${reviewPending.id} — ${untrusted(reviewPending.title)}`,
    `subgoal_complete has already run; gates passed. The previous session's REVIEW_NEEDED payload`,
    `is no longer in your context — call subgoal_complete again to re-emit the payload (idempotent;`,
    `does not re-run gates or increment iteration count), then invoke the goal-reviewer subagent`,
    `(Task tool, subagent_type="goal-reviewer") and submit the verdict via subgoal_submit_review.`,
  ].join("\n");
} else if (active) {
  const lastVerdict = active.review_verdicts?.[active.review_verdicts.length - 1];
  activeBlock = [
    ``,
    `### Currently in progress: ${active.id} — ${untrusted(active.title)}`,
    `Description: ${untrusted(active.description)}`,
    `Done criteria: ${untrusted(active.done_criteria)}`,
    `Iterations: ${active.iteration_count || 0}.`,
    lastVerdict ? `Last verdict: ${lastVerdict.verdict} — ${untrusted(lastVerdict.reasoning?.slice(0, 400) || "(none)")}` : "",
  ].filter(Boolean).join("\n");
} else if (blocked) {
  const lastVerdict = blocked.review_verdicts?.[blocked.review_verdicts.length - 1];
  activeBlock = [
    ``,
    `### Currently BLOCKED: ${blocked.id} — ${untrusted(blocked.title)}`,
    lastVerdict ? `Reason: ${untrusted(lastVerdict.reasoning?.slice(0, 400) || "(none)")}` : "",
    `Surface this to the user. Call subgoal_start with id="${blocked.id}" to retry once unblocked.`,
  ].filter(Boolean).join("\n");
} else if (done === total) {
  activeBlock = `\n### All subgoals complete. Call goal_update with status="complete" to close.`;
} else {
  activeBlock = `\n### No subgoal in progress. Call subgoal_start (no id = next eligible) to begin.`;
}

const additionalContext = [
  `## Active goal in this project`,
  ``,
  `Objective: ${untrusted(goal.objective)}`,
  `Subgoals: ${done}/${total} complete. Elapsed: ${elapsed}s.`,
  ``,
  ...subgoalLines,
  activeBlock,
].join("\n");

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
}));
process.exit(0);
