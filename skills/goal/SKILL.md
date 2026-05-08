---
name: goal
description: Use whenever a user wants to lock in a multi-turn objective and have Claude drive itself toward completion across session pauses, model handoffs, and turn boundaries. Triggers on phrases like "set a goal", "work on this until X is done", "keep going until", "/agenc:goal", "make it autonomous", or any explicit goal/objective framing for a longer-running task.
---

# Goal-Completion Workflow

## What this is

A persistent project-scoped goal with autonomous continuation, automatic subgoal decomposition, per-subgoal correctness gates, and a reviewer subagent that audits the work before each subgoal can be marked complete.

Decomposition and review run as **subagents in your current Claude Code session** (Task tool, `subagent_type="goal-planner"` and `subagent_type="goal-reviewer"`). The MCP server never spawns a separate `claude` subprocess — there is no API-key handshake, no agent re-bootstrap, and review of trivial subgoals stays cheap.

Once a goal is active:

- The decomposition step (called once at goal creation) runs the `goal-planner` subagent to break the objective into 1-8 sequenced subgoals (or skipped via `decompose=false`).
- Each subgoal runs on its own git branch (`agenc-goal/<short>/<sg-N>`), so changes are isolated until the reviewer approves.
- Every turn you'd otherwise stop on, the Stop hook re-prompts with a completion audit scoped to the current subgoal.
- On session resume, SessionStart re-injects the active subgoal into context so you pick up where you left off.
- Calling `subgoal_complete` runs gates (auto-detected or user-defined), then transitions the subgoal to `review_pending` and returns a structured `REVIEW_NEEDED` payload. You then invoke the `goal-reviewer` subagent on that payload and submit the verdict via `subgoal_submit_review`. The branch is merged back into its parent only after `APPROVED`.

State persists in `~/.agenc/agenc-goals.json` (or `$AGENC_GOAL_DB_PATH`), scoped per project directory.

## When to use the goal tools

**Create a goal** with `goal_create({objective: "...", subgoals?: ..., decompose?: boolean})`:

- Only when the user has explicitly asked to start a goal. Do not infer a goal from an ordinary task.
- The objective should be the user's framing of what success looks like, not your own restatement.
- **Default flow (decomposition):**
  1. Invoke the `goal-planner` subagent (Task tool, `subagent_type="goal-planner"`) with the objective as its prompt.
  2. Pass the subagent's raw output (or a parsed array) as `goal_create({objective, subgoals: "<raw>"})`. The MCP server's `resolveSubgoals` helper accepts the raw JSON string, an array, or the subagent's full text and parses it best-effort.
- **Skip decomposition:** call `goal_create({objective, decompose: false})` to run as a single objective with no per-subgoal lifecycle.
- Calling `goal_create({objective})` without either `subgoals` or `decompose: false` returns an actionable error explaining that the goal-planner subagent must be invoked first.

**Inspect** with `goal_get()` (full goal record) or `subgoal_list()` (one-line per subgoal with status glyphs).

**Begin a subgoal** with `subgoal_start({id?: "sg-N"})`:

- No id = picks the next eligible subgoal (deps complete, status pending).
- Creates a git branch from the parent and transitions status `pending → in_progress`.
- Refuses to start a second subgoal in parallel — finish the current one first.

**Request review** with `subgoal_complete({id?: "sg-N"})`:

- No id = targets the in_progress subgoal.
- The MCP tool runs gates → captures the diff → transitions the subgoal to `review_pending` → returns a structured `REVIEW_NEEDED` payload between `--- BEGIN REVIEW PAYLOAD ---` and `--- END REVIEW PAYLOAD ---` markers.
- If the subgoal is already `review_pending` (e.g. session was resumed and the original payload scrolled out of context), `subgoal_complete` re-emits the payload idempotently — gates do not re-run, iteration count does not increase.
- **Never call this for a subgoal you haven't actually finished.** The reviewer will reject premature claims, and the iteration counter will go up. Resist the urge to call it just to make the Stop hook stop nagging.

**Run the reviewer** as a subagent:

- Invoke the `goal-reviewer` subagent (Task tool, `subagent_type="goal-reviewer"`). Pass the review payload (everything between the markers) as the prompt.
- The subagent's last line will be one of: `VERDICT: APPROVED`, `VERDICT: NEEDS_REVISION`, `VERDICT: BLOCKED`.

**Submit the verdict** with `subgoal_submit_review({...})`:

- Easiest form: pass `{reviewer_output: "<full subagent text>"}` and let the server parse the verdict from the last line. The remaining text is recorded as the reasoning.
- Explicit form: pass `{verdict: "APPROVED" | "NEEDS_REVISION" | "BLOCKED", reasoning: "..."}` if you parsed the verdict yourself.
- On `APPROVED`: branch is merged into the parent, subgoal marked complete.
- On `NEEDS_REVISION`: subgoal returns to `in_progress`. Address the feedback and call `subgoal_complete` again.
- On `BLOCKED`: subgoal marked blocked. Surface to the user.
- Unparseable submissions are treated as `NEEDS_REVISION` — never silently approved.

**Close the goal** with `goal_update({status: "complete"})`:

- Refuses if any subgoal is not yet complete. The error returns the exact list of remaining subgoals.
- Call this only after every subgoal has been APPROVED.

## Configuring gates

Gates are correctness checks that run before the reviewer is consulted. By default the plugin auto-detects gates from project markers:

- `package.json` `scripts.test` → `npm test`
- `package.json` `scripts.lint` → `npm run lint`
- `package.json` `scripts.typecheck` → `npm run typecheck`
- `pyproject.toml` or `pytest.ini` → `pytest`
- `Cargo.toml` → `cargo test`
- `go.mod` → `go test ./...`
- `Makefile` with `test:` → `make test`

To override, drop a `.agenc/gates.json` in the project root:

```json
{
  "gates": [
    {"name": "tests", "cmd": "npm test", "timeout_ms": 600000},
    {"name": "lint", "cmd": "npm run lint"}
  ],
  "default_timeout_ms": 300000
}
```

When `.agenc/gates.json` exists, only its gates run — auto-detection is bypassed entirely.

## Status values

For the parent goal:
- `active`: at least one subgoal is not yet complete.
- `complete`: every subgoal complete and `goal_update` was called.

For each subgoal:
- `pending`: not yet started; deps may or may not be satisfied.
- `in_progress`: actively being worked on. Stop hook fires scoped continuation prompts.
- `review_pending`: gates passed and review payload emitted; awaiting goal-reviewer subagent verdict via `subgoal_submit_review`.
- `complete`: reviewer APPROVED + branch merged.
- `blocked`: reviewer returned BLOCKED, merge had conflicts, or iteration cap exceeded. Requires user intervention. Re-enter via `subgoal_start({id: "sg-N"})`.

## Failure modes to avoid

- **Skipping the goal-reviewer subagent.** Submitting a self-generated verdict to `subgoal_submit_review` defeats the whole point of having an independent reviewer. Always invoke the subagent on the REVIEW_NEEDED payload.
- **Premature `subgoal_complete`.** The reviewer subagent has no shared context with you and will catch shortcuts, stubs, half-implementations, and "looks plausible" output. Each rejection burns an iteration.
- **Calling `goal_update` early.** It will refuse cleanly with the list of incomplete subgoals, but it's a wasted call. Wait until every `subgoal_submit_review` returns APPROVED.
- **Goal proliferation.** One active goal per project directory. If the user asks for a new goal while one is active, surface that — don't silently abandon the old one.
- **Hook stuckness.** If the Stop hook keeps firing on the same subgoal and you have nothing left to try, that's a signal the subgoal is genuinely stuck. Submit a BLOCKED verdict via `subgoal_submit_review`, or surface to the user — do not call `goal_update` to escape the loop.
