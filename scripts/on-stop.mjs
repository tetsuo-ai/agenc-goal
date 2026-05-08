#!/usr/bin/env node
// State-aware continuation prompts. NO subprocess work, NO branch
// operations, NO DB mutation — gates and the reviewer live in the
// subgoal_complete MCP tool, not here. Any error exits 0 silently so a
// hook crash can never trap the user in a non-stoppable session.

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

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
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

if (!goal.subgoals?.length) {
  const elapsed = Math.floor((Date.now() - new Date(goal.created_at).getTime()) / 1000);
  block([
    `The objective is still active. Before continuing or claiming completion, run an honest audit:`,
    ``,
    `1. **Restate the objective in your own words.** If you can't, you don't fully understand it — re-read it.`,
    `2. **Enumerate the artifacts the objective requires.** Files, tests, behaviors, side effects. Be specific.`,
    `3. **Inspect the current state.** Read the files you claim to have produced. Run the tests you claim to have written. Do not rely on your prior turn's claims — verify against the filesystem and actual command output.`,
    `4. **Treat uncertainty as not-done.** If you cannot honestly verify each artifact end-to-end, the objective is not achieved.`,
    ``,
    `Do NOT call goal_update with status="complete" because:`,
    `- Time has elapsed`,
    `- You're tired of working on it`,
    `- Your summary sounds plausible`,
    `- You hit a hard problem and want to stop`,
    ``,
    `Call goal_update only when the audit above shows real, verified, end-to-end completion.`,
    ``,
    `Otherwise: take the next concrete step toward ${untrusted(goal.objective)}. Do not stop. Do not summarize. Do not ask for confirmation.`,
    ``,
    `Time spent: ${formatDuration(elapsed)}.`,
  ].join("\n"));
}

const subgoals = goal.subgoals;
const inProgress = subgoals.find((sg) => sg.status === "in_progress");
const reviewPending = subgoals.find((sg) => sg.status === "review_pending");
const blocked = subgoals.find((sg) => sg.status === "blocked");
const allComplete = subgoals.every((sg) => sg.status === "complete");

if (reviewPending) {
  block([
    `Subgoal awaiting review: ${reviewPending.id} — ${untrusted(reviewPending.title)}`,
    ``,
    `subgoal_complete already ran (gates passed). The review payload was emitted to your last`,
    `subgoal_complete response — find it in your transcript between "BEGIN REVIEW PAYLOAD" and`,
    `"END REVIEW PAYLOAD" markers.`,
    ``,
    `Next steps:`,
    `1. Invoke the goal-reviewer subagent (Task tool with subagent_type="goal-reviewer"), passing`,
    `   the review payload as its prompt.`,
    `2. Capture the subagent's final response. The last line will be VERDICT: APPROVED |`,
    `   NEEDS_REVISION | BLOCKED.`,
    `3. Call subgoal_submit_review({reviewer_output: "<full subagent text>"}) to submit the verdict`,
    `   — or {verdict, reasoning} if you parsed it yourself.`,
    ``,
    `Do NOT skip the subagent and self-approve. Do NOT call subgoal_complete again — it will reject.`,
  ].join("\n"));
}

if (inProgress) {
  const lastVerdict = inProgress.review_verdicts?.[inProgress.review_verdicts.length - 1];
  const verdictLine = lastVerdict
    ? `\nMost recent reviewer verdict on this subgoal: ${lastVerdict.verdict}\nFeedback: ${untrusted(lastVerdict.reasoning?.slice(0, 600) || "(none)")}`
    : "";

  block([
    `Subgoal in progress: ${inProgress.id} — ${untrusted(inProgress.title)}`,
    ``,
    `Description: ${untrusted(inProgress.description)}`,
    `Done criteria: ${untrusted(inProgress.done_criteria)}`,
    `Iterations so far: ${inProgress.iteration_count || 0}.`,
    verdictLine,
    ``,
    `Audit completion of THIS SUBGOAL specifically (not the whole goal):`,
    `1. Does the work satisfy the done criteria above?`,
    `2. Is there a specific gap that the reviewer would catch?`,
    `3. Are there shortcuts, stubs, or placeholders?`,
    ``,
    `If genuinely done: call subgoal_complete to run gates; you will receive a REVIEW_NEEDED`,
    `payload to feed to the goal-reviewer subagent, then submit its verdict via subgoal_submit_review.`,
    `Otherwise: take the next concrete step toward this subgoal. Do not stop.`,
  ].filter(Boolean).join("\n"));
}

if (blocked) {
  const lastVerdict = blocked.review_verdicts?.[blocked.review_verdicts.length - 1];
  block([
    `Subgoal ${blocked.id} is BLOCKED: ${untrusted(blocked.title)}`,
    ``,
    lastVerdict
      ? `Reviewer/system reason: ${untrusted(lastVerdict.reasoning?.slice(0, 800) || lastVerdict.verdict)}`
      : `(no detailed reason recorded)`,
    ``,
    `This subgoal cannot proceed without intervention. Surface the blocker to the user.`,
    `If the user has resolved the blocker, call subgoal_start with id="${blocked.id}" to retry.`,
  ].join("\n"));
}

if (allComplete) {
  block([
    `All ${subgoals.length} subgoals for ${untrusted(goal.objective)} are complete.`,
    ``,
    `Call goal_update with status="complete" to close out the goal. The Stop hook will go silent after that.`,
  ].join("\n"));
}

const nextEligible = subgoals.find((sg) => {
  if (sg.status !== "pending") return false;
  return (sg.depends_on || []).every(
    (d) => subgoals.find((s) => s.id === d)?.status === "complete",
  );
});

if (nextEligible) {
  block([
    `No subgoal currently in progress, but ${subgoals.filter((s) => s.status === "pending").length} pending remain.`,
    ``,
    `Next eligible: ${nextEligible.id} — ${untrusted(nextEligible.title)}`,
    ``,
    `Call subgoal_start to begin (no id = next eligible). Do not stop until all subgoals complete.`,
  ].join("\n"));
}

// Nothing eligible (remaining pending subgoals are waiting on a blocked
// dependency). Let the stop happen so the user can intervene.
process.exit(0);
