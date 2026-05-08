#!/usr/bin/env node
// One active goal per project directory, persisted at $AGENC_GOAL_DB_PATH.
// Goals without a `subgoals` array (v0.1 records) take the single-goal path.
//
// Decomposition and review run as subagents in the parent Claude Code
// session — see agents/goal-planner.md and agents/goal-reviewer.md.
// The MCP server never spawns a `claude` subprocess; it builds payloads
// for the parent to feed to the subagents and parses the verdicts the
// parent submits back via subgoal_submit_review.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { loadDb, mutateDb } from "../lib/db.mjs";
import {
  resolveSubgoals,
  normalize,
  singletonSubgoal,
} from "../lib/planner.mjs";
import { resolveGates, runGates } from "../lib/gate-runner.mjs";
import {
  buildReviewPayload,
  normalizeSubmittedVerdict,
} from "../lib/reviewer.mjs";
import {
  inGitRepo,
  startSubgoalBranch,
  mergeSubgoalBranch,
  diffSubgoalBranch,
} from "../lib/branch-helper.mjs";

const threadId = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const MAX_ITERATIONS = parseInt(process.env.AGENC_GOAL_MAX_ITERATIONS) || 10;

const VALID_TRANSITIONS = {
  pending: ["in_progress"],
  in_progress: ["review_pending"],
  review_pending: ["complete", "in_progress", "blocked"],
  blocked: ["in_progress"],
  complete: [],
};

function canTransition(from, to) {
  return (VALID_TRANSITIONS[from] || []).includes(to);
}

function findSubgoal(goal, id) {
  return goal.subgoals?.find((sg) => sg.id === id) || null;
}

function activeSubgoal(goal) {
  return goal.subgoals?.find((sg) => sg.status === "in_progress") || null;
}

function reviewPendingSubgoal(goal) {
  return goal.subgoals?.find((sg) => sg.status === "review_pending") || null;
}

function nextEligibleSubgoal(goal) {
  if (!goal.subgoals) return null;
  for (const sg of goal.subgoals) {
    if (sg.status !== "pending") continue;
    const depsOk = (sg.depends_on || []).every(
      (d) => findSubgoal(goal, d)?.status === "complete",
    );
    if (depsOk) return sg;
  }
  return null;
}

function elapsedSeconds(goal) {
  return Math.floor((Date.now() - new Date(goal.created_at).getTime()) / 1000);
}

const server = new Server(
  { name: "agenc-goal", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "goal_create",
      description:
        "Create an active goal for this project. Fails if an active goal already exists. " +
        "Use only when the user has explicitly asked to start a goal — do not infer from ordinary tasks. " +
        "Decomposition is performed by the caller: invoke the `goal-planner` subagent (Task tool, " +
        "subagent_type='goal-planner') with the objective, then pass its raw JSON output (or a parsed " +
        "subgoals array) as the `subgoals` argument here. To skip decomposition entirely, pass " +
        "`decompose=false` and the objective will run as a single subgoal.",
      inputSchema: {
        type: "object",
        properties: {
          objective: {
            type: "string",
            description: "What the goal achieves, in the user's own words where possible.",
          },
          subgoals: {
            description:
              "Decomposed subgoals from the goal-planner subagent. May be either an array of " +
              "subgoal objects ({id,title,description,done_criteria,depends_on}) or the raw JSON " +
              "string returned by the subagent. If omitted and decompose!=false, the call returns " +
              "an error instructing the caller to invoke goal-planner first.",
          },
          decompose: {
            type: "boolean",
            description:
              "Set to false to bypass decomposition and run the objective as a single subgoal. " +
              "Default true. Ignored when `subgoals` is provided.",
          },
        },
        required: ["objective"],
      },
    },
    {
      name: "goal_get",
      description: "Get the active goal for this project, including objective, status, and (if decomposed) subgoals.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "goal_update",
      description:
        "Mark the active goal complete. If the goal has subgoals, all subgoals must be complete first " +
        "(call this only after every subgoal_submit_review has returned APPROVED). Set status to 'complete' " +
        "only when the objective has actually been achieved end-to-end.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["complete"] },
        },
        required: ["status"],
      },
    },
    {
      name: "subgoal_list",
      description: "List all subgoals for the active goal with their status and dependencies.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "subgoal_get",
      description:
        "Get a specific subgoal by id, or the currently in-progress / review-pending subgoal if no id is given.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Subgoal id (e.g. 'sg-1'). Omit to get the active subgoal." },
        },
      },
    },
    {
      name: "subgoal_start",
      description:
        "Begin work on a subgoal. Transitions status pending → in_progress and creates a git branch " +
        "(`agenc-goal/<short>/<sg-id>`) for isolated changes. Fails if dependencies are unmet, the subgoal " +
        "is already in_progress on a different id, or the subgoal has been completed.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Subgoal id to start. Omit to start the next eligible subgoal." },
        },
      },
    },
    {
      name: "subgoal_complete",
      description:
        "Phase 1 of the two-phase completion flow. The MCP server: (1) captures the git diff vs the parent " +
        "branch, (2) runs configured gates (auto-detected or .agenc/gates.json), (3) transitions the subgoal " +
        "to status `review_pending` and returns a structured REVIEW_NEEDED payload. The CALLER must then " +
        "invoke the `goal-reviewer` subagent (Task tool, subagent_type='goal-reviewer') with the returned " +
        "payload, parse the verdict, and call `subgoal_submit_review`. NEVER call this for a subgoal you " +
        "haven't actually finished — the reviewer will reject premature claims and waste the iteration.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Subgoal id. Omit to complete the in-progress subgoal." },
        },
      },
    },
    {
      name: "subgoal_submit_review",
      description:
        "Phase 2 of the two-phase completion flow. After invoking the `goal-reviewer` subagent on a " +
        "REVIEW_NEEDED payload, submit its verdict here. On APPROVED, the MCP server merges the subgoal " +
        "branch into its parent and marks the subgoal complete. On NEEDS_REVISION, the subgoal returns to " +
        "status `in_progress` for another iteration. On BLOCKED, the subgoal is marked blocked. Pass either " +
        "{verdict, reasoning} for explicit submission or {reviewer_output} to have the server parse the " +
        "verdict from the subagent's raw final text.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Subgoal id. Omit to submit for the review_pending subgoal." },
          verdict: {
            type: "string",
            enum: ["APPROVED", "NEEDS_REVISION", "BLOCKED"],
            description: "The reviewer's verdict.",
          },
          reasoning: {
            type: "string",
            description: "The reviewer's reasoning text. Surfaced back to the implementer on NEEDS_REVISION/BLOCKED.",
          },
          reviewer_output: {
            type: "string",
            description:
              "Alternative to {verdict, reasoning}: the full raw text the goal-reviewer subagent returned. " +
              "The server parses the last line for the verdict and uses the rest as reasoning.",
          },
        },
      },
    },
    {
      name: "goal_clear",
      description:
        "Abandon and remove the active goal for this project. Use ONLY when the user explicitly asks to abandon, cancel, give up, or delete the current goal — not for completion (use goal_update for that). The goal record (including all subgoals, branches, gate results, verdicts) is deleted; create a new goal afterward with goal_create.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (name === "goal_create") return handleGoalCreate(args);
  if (name === "goal_get") return handleGoalGet();
  if (name === "goal_update") return handleGoalUpdate(args);
  if (name === "goal_clear") return handleGoalClear();
  if (name === "subgoal_list") return handleSubgoalList();
  if (name === "subgoal_get") return handleSubgoalGet(args);
  if (name === "subgoal_start") return handleSubgoalStart(args);
  if (name === "subgoal_complete") return handleSubgoalComplete(args);
  if (name === "subgoal_submit_review") return handleSubgoalSubmitReview(args);

  return errorResult(`Unknown tool: ${name}`);
});

async function handleGoalCreate(args) {
  // Pre-check (without lock) so we fail fast on duplicate goals before
  // doing any subgoal-resolution work. The lock-acquired phase below
  // re-checks before writing to close the TOCTOU window.
  const preDb = await loadDb();
  const existing = preDb.goals[threadId];
  if (existing && existing.status !== "complete") {
    return errorResult(
      `An active goal already exists for this project: "${existing.objective}" ` +
        `(status: ${existing.status}). Mark it complete before creating a new one.`,
    );
  }

  const decompose = args.decompose !== false;
  let subgoals = null;
  let trackSubgoals = false;
  let plannerNote = "";

  if (args.subgoals !== undefined && args.subgoals !== null) {
    const raw = resolveSubgoals(args.subgoals);
    if (!raw) {
      return errorResult(
        `Could not parse the \`subgoals\` argument. Expected an array of subgoal objects, ` +
          `a JSON string of the form {"subgoals":[...]}, or the raw goal-planner subagent output. ` +
          `Re-invoke the goal-planner subagent and pass its output verbatim, or pass decompose=false ` +
          `to run as a single objective.`,
      );
    }
    subgoals = normalize(raw, args.objective);
    trackSubgoals = true;
    plannerNote = subgoals.length === 1
      ? " (planner returned a single atomic subgoal)."
      : ` Decomposed into ${subgoals.length} subgoals.`;
  } else if (!decompose) {
    // v0.1-style single-objective mode: no subgoals array, no per-subgoal
    // lifecycle. The Stop hook still re-prompts on the goal itself.
    plannerNote = " (decompose=false — running as single objective).";
  } else {
    return errorResult(
      `Decomposition is required by default but no \`subgoals\` argument was supplied.\n\n` +
        `Invoke the \`goal-planner\` subagent first (Task tool with subagent_type="goal-planner") and ` +
        `pass the objective as its prompt:\n\n` +
        `  Objective: ${args.objective}\n\n` +
        `Then re-call goal_create with the subagent's raw JSON output (or a parsed subgoals array) ` +
        `as the \`subgoals\` argument.\n\n` +
        `To skip decomposition entirely, re-call goal_create with decompose=false.`,
    );
  }

  const isGitRepo = await inGitRepo(process.cwd());
  const noGitWarning = trackSubgoals && !isGitRepo
    ? " Note: this project isn't a git repo, so subgoals will run without branch isolation; the reviewer will audit against done-criteria only."
    : "";

  return mutateDb((db) => {
    const existing2 = db.goals[threadId];
    if (existing2 && existing2.status !== "complete") {
      return errorResult(
        `An active goal already exists for this project: "${existing2.objective}".`,
      );
    }
    const now = new Date().toISOString();
    const goal = {
      goal_id: randomUUID(),
      objective: args.objective,
      status: "active",
      created_at: now,
      updated_at: now,
    };
    if (trackSubgoals) {
      goal.subgoals = subgoals.map((sg) => ({
        ...sg,
        status: "pending",
        branch: null,
        parent_branch: null,
        started_at: null,
        completed_at: null,
        iteration_count: 0,
        gate_results: [],
        review_verdicts: [],
      }));
    }
    db.goals[threadId] = goal;
    return okResult(formatGoalCreatedMessage(goal, plannerNote, noGitWarning));
  });
}

function formatGoalCreatedMessage(goal, plannerNote, noGitWarning) {
  if (!goal.subgoals) {
    return `Goal created: "${goal.objective}".${plannerNote}${noGitWarning}\n\n` +
      `Continue working until the objective is achieved end-to-end, then call goal_update with status="complete".`;
  }
  const list = goal.subgoals
    .map((sg, i) => `  ${i + 1}. ${sg.id}: ${sg.title}${sg.depends_on?.length ? ` (depends on ${sg.depends_on.join(", ")})` : ""}`)
    .join("\n");
  return `Goal created: "${goal.objective}".${plannerNote}${noGitWarning}\n\n` +
    `Subgoals:\n${list}\n\n` +
    `Call subgoal_start to begin (no id = first eligible). When you believe a subgoal is done, call ` +
    `subgoal_complete to run gates and get a REVIEW_NEEDED payload; then invoke the goal-reviewer ` +
    `subagent and submit the verdict via subgoal_submit_review. After all subgoals complete, call ` +
    `goal_update with status="complete".`;
}

async function handleGoalGet() {
  const db = await loadDb();
  const goal = db.goals[threadId];
  if (!goal) return okResult("No goal exists for this project.");
  const view = { ...goal, time_used_seconds: elapsedSeconds(goal) };
  return okResult(JSON.stringify(view, null, 2));
}

async function handleGoalUpdate(args) {
  return mutateDb((db) => {
    const goal = db.goals[threadId];
    if (!goal) return errorResult("No goal exists for this project.");
    if (args.status !== "complete") {
      return errorResult("Only status='complete' is allowed via this tool.");
    }
    if (goal.subgoals?.length) {
      const incomplete = goal.subgoals.filter((sg) => sg.status !== "complete");
      if (incomplete.length > 0) {
        const list = incomplete.map((sg) => `  ${sg.id} (${sg.status}): ${sg.title}`).join("\n");
        return errorResult(
          `Cannot mark goal complete: ${incomplete.length} subgoal(s) not yet complete:\n${list}\n\n` +
            `Each subgoal must be approved by the reviewer (call subgoal_complete then subgoal_submit_review) before this tool will succeed.`,
        );
      }
    }
    goal.status = "complete";
    goal.updated_at = new Date().toISOString();
    goal.time_used_seconds = elapsedSeconds(goal);
    return okResult(`Goal "${goal.objective}" marked complete.`);
  });
}

async function handleGoalClear() {
  return mutateDb((db) => {
    const goal = db.goals[threadId];
    if (!goal) return errorResult("No goal exists for this project to clear.");
    delete db.goals[threadId];
    return okResult(
      `Goal "${goal.objective}" cleared. ${goal.subgoals?.length || 0} subgoal(s) discarded. ` +
      `Note: per-subgoal git branches (agenc-goal/*) are NOT deleted — clean up manually if you want them gone.`,
    );
  });
}

async function handleSubgoalList() {
  const db = await loadDb();
  const goal = db.goals[threadId];
  if (!goal) return errorResult("No goal exists for this project.");
  if (!goal.subgoals?.length) {
    return okResult("This goal has no subgoals (single-objective mode).");
  }
  const lines = goal.subgoals.map((sg) => {
    const deps = sg.depends_on?.length ? ` ← deps: [${sg.depends_on.join(", ")}]` : "";
    const iter = sg.iteration_count ? ` (iter ${sg.iteration_count})` : "";
    return `  [${statusGlyph(sg.status)}] ${sg.id}${iter}: ${sg.title}${deps}`;
  });
  return okResult(`Subgoals for "${goal.objective}":\n${lines.join("\n")}`);
}

function statusGlyph(s) {
  return { pending: " ", in_progress: "~", review_pending: "?", complete: "x", blocked: "!" }[s] || "?";
}

async function handleSubgoalGet(args) {
  const db = await loadDb();
  const goal = db.goals[threadId];
  if (!goal) return errorResult("No goal exists for this project.");
  if (!goal.subgoals?.length) return errorResult("This goal has no subgoals.");

  const sg = args.id
    ? findSubgoal(goal, args.id)
    : (activeSubgoal(goal) || reviewPendingSubgoal(goal));
  if (!sg) {
    return args.id
      ? errorResult(`Subgoal ${args.id} not found.`)
      : errorResult("No subgoal is currently in_progress or review_pending. Call subgoal_start to begin one.");
  }
  return okResult(JSON.stringify(sg, null, 2));
}

async function handleSubgoalStart(args) {
  // Eligibility checks run unlocked for fast-fail. The lock-acquired phase
  // below re-verifies no other subgoal is in_progress and creates the branch
  // under the same lock as the status flip — preventing concurrent
  // in_progress subgoals and orphan branches from a failed flip.
  const preDb = await loadDb();
  const goal = preDb.goals[threadId];
  if (!goal) return errorResult("No goal exists for this project.");
  if (!goal.subgoals?.length) return errorResult("This goal has no subgoals.");

  let target;
  if (args.id) {
    target = findSubgoal(goal, args.id);
    if (!target) return errorResult(`Subgoal ${args.id} not found.`);
    if (target.status === "complete") {
      return errorResult(`Subgoal ${target.id} is already complete.`);
    }
    if (target.status === "in_progress") {
      return okResult(`Subgoal ${target.id} is already in_progress: ${target.title}`);
    }
    if (target.status === "review_pending") {
      return errorResult(
        `Subgoal ${target.id} is awaiting review. Invoke the goal-reviewer subagent and call ` +
          `subgoal_submit_review with the verdict instead of restarting it.`,
      );
    }
    if (target.status === "pending") {
      const unmetDeps = (target.depends_on || []).filter(
        (d) => findSubgoal(goal, d)?.status !== "complete",
      );
      if (unmetDeps.length) {
        return errorResult(
          `Subgoal ${target.id} has unmet dependencies: ${unmetDeps.join(", ")}`,
        );
      }
    }
  } else {
    target = nextEligibleSubgoal(goal);
    if (!target) {
      const ip = activeSubgoal(goal);
      if (ip) return okResult(`Subgoal already in_progress: ${ip.id} — ${ip.title}`);
      const rp = reviewPendingSubgoal(goal);
      if (rp) {
        return errorResult(
          `Subgoal ${rp.id} is awaiting review. Invoke the goal-reviewer subagent and call ` +
            `subgoal_submit_review with the verdict.`,
        );
      }
      return errorResult("No eligible subgoals to start. All complete, or remaining are blocked / waiting on deps.");
    }
  }

  return mutateDb(async (db) => {
    const g = db.goals[threadId];
    if (!g) return errorResult("No goal exists for this project.");
    const sg = findSubgoal(g, target.id);
    if (!sg) return errorResult(`Subgoal ${target.id} not found.`);
    if (sg.status !== "pending" && sg.status !== "blocked") {
      if (sg.status === "in_progress") {
        return okResult(`Subgoal ${sg.id} is already in_progress: ${sg.title}`);
      }
      return errorResult(`Cannot start ${sg.id}: status is ${sg.status}.`);
    }
    const concurrent = g.subgoals.find(
      (s) => (s.status === "in_progress" || s.status === "review_pending") && s.id !== sg.id,
    );
    if (concurrent) {
      return errorResult(
        `Subgoal ${concurrent.id} is already ${concurrent.status}. Resolve it before starting ${sg.id}.`,
      );
    }
    if (!canTransition(sg.status, "in_progress")) {
      return errorResult(`Cannot transition ${sg.id} from ${sg.status} to in_progress.`);
    }

    const branchResult = await startSubgoalBranch(process.cwd(), g.goal_id, sg.id);
    let branchInfo = "";
    if (branchResult.ok) {
      branchInfo = ` Branch: ${branchResult.branch} (forked from ${branchResult.parent}${branchResult.reused ? ", reused" : ""}).`;
    } else if (branchResult.reason === "not_git_repo") {
      branchInfo = " (not a git repo — running without branch isolation)";
    } else {
      return errorResult(`Failed to create branch for ${sg.id}: ${branchResult.error || branchResult.reason}`);
    }

    sg.status = "in_progress";
    sg.started_at = sg.started_at || new Date().toISOString();
    if (branchResult.ok) {
      sg.branch = branchResult.branch;
      sg.parent_branch = branchResult.parent;
    }
    g.updated_at = new Date().toISOString();
    return okResult(formatSubgoalStartMessage(sg, branchInfo));
  });
}

function formatSubgoalStartMessage(sg, branchInfo) {
  return [
    `Subgoal ${sg.id} started: ${sg.title}`,
    ``,
    `Description: ${sg.description}`,
    `Done criteria: ${sg.done_criteria}`,
    branchInfo,
    ``,
    `Work toward this subgoal. When the work is genuinely done, call subgoal_complete to run gates ` +
      `and receive a REVIEW_NEEDED payload to feed to the goal-reviewer subagent.`,
  ].join("\n");
}

async function handleSubgoalComplete(args) {
  const preDb = await loadDb();
  const goal = preDb.goals[threadId];
  if (!goal) return errorResult("No goal exists for this project.");
  if (!goal.subgoals?.length) return errorResult("This goal has no subgoals.");

  const target = args.id
    ? findSubgoal(goal, args.id)
    : (activeSubgoal(goal) || reviewPendingSubgoal(goal));
  if (!target) {
    if (args.id) return errorResult(`Subgoal ${args.id} not found.`);
    return errorResult("No subgoal is in_progress. Call subgoal_start first.");
  }

  // Idempotent re-emit: if already review_pending (e.g. session resumed after
  // the original payload scrolled out of context), rebuild and return the
  // payload without re-running gates or incrementing the iteration count.
  if (target.status === "review_pending") {
    const cwd = process.cwd();
    const diff = target.branch && target.parent_branch
      ? (await diffSubgoalBranch(cwd, target.branch, target.parent_branch)) || ""
      : "";
    const payload = buildReviewPayload({
      objective: goal.objective,
      subgoal: target,
      diff,
      gate_results: target.gate_results || [],
    });
    return okResult(formatReviewNeededMessage(target, payload, /*reEmit*/ true));
  }

  if (target.status !== "in_progress") {
    return errorResult(`Subgoal ${target.id} is ${target.status}, not in_progress. Cannot run completion check.`);
  }

  // Increment iteration count up front so it survives a crash mid-call.
  const newCount = await mutateDb((db) => {
    const sg = findSubgoal(db.goals[threadId], target.id);
    sg.iteration_count = (sg.iteration_count || 0) + 1;
    return sg.iteration_count;
  });

  if (newCount > MAX_ITERATIONS) {
    const capVerdict = {
      verdict: "BLOCKED",
      reasoning: `Iteration cap (${MAX_ITERATIONS}) exceeded for this subgoal. Reviewer rejected ${newCount - 1} previous attempts. Surface this to the user — the subgoal is likely stuck and needs human intervention or a redefinition. Override AGENC_GOAL_MAX_ITERATIONS env var to raise the cap.`,
    };
    await recordVerdictAndStatus(target.id, capVerdict, [], "blocked");
    return errorResult(formatBlockedMessage(target, {
      verdict: "BLOCKED",
      reasoning: `Iteration cap (${MAX_ITERATIONS}) exceeded.`,
    }));
  }

  const cwd = process.cwd();
  const gates = await resolveGates(cwd);
  const gateRun = gates.length > 0
    ? await runGates(gates, cwd)
    : { passed: true, results: [] };

  if (!gateRun.passed) {
    const failedGates = gateRun.results.filter(
      (r) => r.exit !== 0 || r.timed_out || r.signal,
    );
    const failedNames = failedGates.map((r) => r.name).join(", ");
    await mutateDb((db) => {
      const sg = findSubgoal(db.goals[threadId], target.id);
      sg.gate_results = gateRun.results;
      sg.review_verdicts = sg.review_verdicts || [];
      sg.review_verdicts.push({
        verdict: "NEEDS_REVISION",
        reasoning: `Gates failed before reviewer ran: ${failedNames}. See gate_results for stdout/stderr details.`,
        at: new Date().toISOString(),
      });
      db.goals[threadId].updated_at = new Date().toISOString();
    });
    return errorResult(formatGateFailure(target, gateRun.results));
  }

  const diff = target.branch && target.parent_branch
    ? (await diffSubgoalBranch(cwd, target.branch, target.parent_branch)) || ""
    : "";

  // Stash gate results + transition to review_pending under the lock so a
  // crash before the caller submits the review still leaves the subgoal
  // in a recoverable state (Stop hook will re-prompt to invoke reviewer).
  await mutateDb((db) => {
    const g = db.goals[threadId];
    const sg = findSubgoal(g, target.id);
    sg.gate_results = gateRun.results;
    sg.status = "review_pending";
    g.updated_at = new Date().toISOString();
  });

  const payload = buildReviewPayload({
    objective: goal.objective,
    subgoal: target,
    diff,
    gate_results: gateRun.results,
  });

  return okResult(formatReviewNeededMessage(target, payload));
}

async function handleSubgoalSubmitReview(args) {
  const preDb = await loadDb();
  const goal = preDb.goals[threadId];
  if (!goal) return errorResult("No goal exists for this project.");
  if (!goal.subgoals?.length) return errorResult("This goal has no subgoals.");

  const target = args.id
    ? findSubgoal(goal, args.id)
    : reviewPendingSubgoal(goal);
  if (!target) {
    return args.id
      ? errorResult(`Subgoal ${args.id} not found.`)
      : errorResult("No subgoal is in review_pending. Call subgoal_complete first to request review.");
  }
  if (target.status !== "review_pending") {
    return errorResult(
      `Subgoal ${target.id} is ${target.status}, not review_pending. Cannot submit a review verdict. ` +
        `Call subgoal_complete first if you believe the subgoal is done.`,
    );
  }

  const verdict = normalizeSubmittedVerdict(args);
  if (!verdict) {
    // Treat unparseable submissions as NEEDS_REVISION rather than auto-approve.
    const reason =
      `subgoal_submit_review could not parse a verdict from the arguments. Expected either ` +
      `{verdict: "APPROVED"|"NEEDS_REVISION"|"BLOCKED", reasoning?: string} or ` +
      `{reviewer_output: "<full subagent text ending in 'VERDICT: ...'>"}. Treating as NEEDS_REVISION.`;
    const stub = { verdict: "NEEDS_REVISION", reasoning: reason };
    await recordVerdictAndStatus(target.id, stub, target.gate_results || [], "in_progress");
    return errorResult(formatNeedsRevisionMessage(target, stub));
  }

  if (verdict.verdict === "APPROVED") {
    let mergeNote = "";
    if (target.branch && target.parent_branch) {
      const m = await mergeSubgoalBranch(process.cwd(), target.branch, target.parent_branch);
      if (!m.ok) {
        if (m.reason === "merge_conflict") {
          await recordVerdictAndStatus(target.id, verdict, target.gate_results || [], "blocked");
          return errorResult(formatMergeConflict(target, m.error));
        }
        // Non-conflict git error: keep the subgoal in review_pending so a
        // retry can complete it after the user fixes the underlying repo
        // state. We don't record a verdict yet — a retry will resubmit.
        return errorResult(`Merge failed for ${target.id}: ${m.error || m.reason}. Resolve manually and call subgoal_submit_review again.`);
      }
      mergeNote = ` Branch ${target.branch} merged into ${target.parent_branch}.`;
    }
    await recordVerdictAndStatus(target.id, verdict, target.gate_results || [], "complete");
    return okResult(formatApprovedMessage(target, mergeNote, verdict));
  }

  if (verdict.verdict === "BLOCKED") {
    await recordVerdictAndStatus(target.id, verdict, target.gate_results || [], "blocked");
    return errorResult(formatBlockedMessage(target, verdict));
  }

  // NEEDS_REVISION
  await recordVerdictAndStatus(target.id, verdict, target.gate_results || [], "in_progress");
  return errorResult(formatNeedsRevisionMessage(target, verdict));
}

async function recordVerdictAndStatus(subgoalId, verdict, gateResults, newStatus) {
  await mutateDb((db) => {
    const goal = db.goals[threadId];
    const sg = findSubgoal(goal, subgoalId);
    sg.gate_results = gateResults;
    sg.review_verdicts = sg.review_verdicts || [];
    sg.review_verdicts.push({
      verdict: verdict.verdict,
      reasoning: verdict.reasoning,
      at: new Date().toISOString(),
    });
    if (newStatus === "complete") {
      sg.status = "complete";
      sg.completed_at = new Date().toISOString();
    } else if (newStatus === "blocked") {
      sg.status = "blocked";
    } else {
      sg.status = "in_progress";
    }
    goal.updated_at = new Date().toISOString();
  });
}

function formatGateFailure(sg, results) {
  const fails = results.filter((r) => r.exit !== 0 || r.timed_out);
  const summary = fails.map((r) =>
    `  - ${r.name} (${r.cmd}) — exit ${r.exit}${r.timed_out ? " (TIMED OUT)" : ""}\n` +
    (r.stderr ? `    stderr: ${r.stderr.slice(-400)}` : ""),
  ).join("\n");
  return [
    `Subgoal ${sg.id} cannot complete — gates failed:`,
    summary,
    ``,
    `Fix the gate failures, then call subgoal_complete again. The reviewer was NOT consulted (gates run first).`,
  ].join("\n");
}

function formatReviewNeededMessage(sg, payload, reEmit = false) {
  const header = reEmit
    ? `Subgoal ${sg.id} status: REVIEW_NEEDED (re-emitted; subgoal was already review_pending)`
    : `Subgoal ${sg.id} status: REVIEW_NEEDED`;
  const intro = reEmit
    ? `Re-emitting the previously generated review payload — gates already passed, iteration not ` +
        `incremented. Invoke the goal-reviewer subagent with the payload below (Task tool, ` +
        `subagent_type="goal-reviewer"), then call subgoal_submit_review with the verdict.`
    : `Gates passed. Subgoal is now review_pending. Invoke the goal-reviewer subagent with the ` +
        `payload below (Task tool, subagent_type="goal-reviewer"), then call subgoal_submit_review ` +
        `with the verdict. Do NOT skip the subagent and self-approve — the reviewer is what catches ` +
        `premature completion.`;
  return [
    header,
    ``,
    intro,
    ``,
    `--- BEGIN REVIEW PAYLOAD ---`,
    payload,
    `--- END REVIEW PAYLOAD ---`,
    ``,
    `After the subagent returns, call:`,
    `  subgoal_submit_review({verdict: "APPROVED" | "NEEDS_REVISION" | "BLOCKED", reasoning: "..."})`,
    `or pass the subagent's raw output:`,
    `  subgoal_submit_review({reviewer_output: "...full subagent text..."})`,
  ].join("\n");
}

function formatNeedsRevisionMessage(sg, verdict) {
  return [
    `Subgoal ${sg.id} review verdict: NEEDS_REVISION`,
    ``,
    `Reviewer feedback:`,
    verdict.reasoning,
    ``,
    `Address the gaps above, then call subgoal_complete again. Subgoal is back in_progress.`,
  ].join("\n");
}

function formatBlockedMessage(sg, verdict) {
  return [
    `Subgoal ${sg.id} review verdict: BLOCKED`,
    ``,
    `Reviewer feedback:`,
    verdict.reasoning,
    ``,
    `Subgoal moved to status=blocked. Surface this to the user — it cannot proceed without intervention. ` +
    `To force-restart after resolving the blocker, call subgoal_start with id="${sg.id}".`,
  ].join("\n");
}

function formatApprovedMessage(sg, mergeNote, verdict) {
  return [
    `Subgoal ${sg.id} APPROVED.${mergeNote}`,
    ``,
    `Reviewer notes: ${verdict.reasoning?.slice(0, 500) || "(none)"}`,
    ``,
    `Call subgoal_start to advance to the next subgoal (no id = next eligible). ` +
    `When all subgoals are complete, call goal_update with status="complete".`,
  ].join("\n");
}

function formatMergeConflict(sg, error) {
  return [
    `Subgoal ${sg.id} APPROVED by reviewer, but MERGE FAILED:`,
    error?.slice(0, 800) || "(no details)",
    ``,
    `Subgoal moved to status=blocked. Resolve the conflict manually, then call subgoal_start ` +
    `with id="${sg.id}" to retry the completion flow.`,
  ].join("\n");
}

function okResult(text) {
  return { content: [{ type: "text", text }] };
}

function errorResult(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

const transport = new StdioServerTransport();
await server.connect(transport);
