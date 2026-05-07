---
name: goal
description: Use whenever a user wants to lock in a multi-turn objective and have Claude drive itself toward completion across session pauses, model handoffs, and turn boundaries. Triggers on phrases like "set a goal", "work on this until X is done", "keep going until", "/agenc:goal", "make it autonomous", or any explicit goal/objective framing for a longer-running task.
---

# Goal-Completion Workflow

## What this is

A persistent project-scoped goal with autonomous continuation, automatic subgoal decomposition, per-subgoal correctness gates, and a reviewer subagent that audits the work before each subgoal can be marked complete.

Once a goal is active:

- The planner subprocess decomposes the user's objective into 1-8 sequenced subgoals (skipped automatically if the objective is atomic).
- Each subgoal runs on its own git branch (`agenc-goal/<short>/<sg-N>`), so changes are isolated until the reviewer approves.
- Every turn you'd otherwise stop on, the Stop hook re-prompts with a completion audit scoped to the current subgoal.
- On session resume, SessionStart re-injects the active subgoal into context so you pick up where you left off.
- Calling `subgoal_complete` runs gates (auto-detected or user-defined), then spawns a reviewer subprocess that audits the diff. The reviewer returns `APPROVED`, `NEEDS_REVISION`, or `BLOCKED`.
- The branch is merged back into its parent only after `APPROVED`.

State persists in `~/.agenc/agenc-goals.json` (or `$AGENC_GOAL_DB_PATH`), scoped per project directory.

## When to use the goal tools

**Create a goal** with `goal_create({objective: "...", decompose?: boolean})`:

- Only when the user has explicitly asked you to start a goal. Do not infer a goal from an ordinary task.
- The objective should be the user's framing of what success looks like, not your own restatement.
- `decompose` defaults to `true`. Set to `false` if the user explicitly wants single-objective mode (no subgoals).

**Inspect** with `goal_get()` (full goal record) or `subgoal_list()` (one-line per subgoal with status glyphs).

**Begin a subgoal** with `subgoal_start({id?: "sg-N"})`:

- No id = picks the next eligible subgoal (deps complete, status pending).
- Creates a git branch from the parent and transitions status `pending → in_progress`.
- Refuses to start a second subgoal in parallel — finish the current one first.

**Request completion** with `subgoal_complete({id?: "sg-N"})`:

- No id = completes the in_progress subgoal.
- The MCP tool runs gates → spawns reviewer → either merges and marks complete, or returns rejection feedback.
- **Never call this for a subgoal you haven't actually finished.** The reviewer will reject premature claims, and the iteration counter will go up. Resist the urge to call it just to make the Stop hook stop nagging.

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
- `complete`: reviewer APPROVED + branch merged.
- `blocked`: reviewer returned BLOCKED, or merge had conflicts. Requires user intervention. Re-enter via `subgoal_start({id: "sg-N"})`.

## Failure modes to avoid

- **Premature `subgoal_complete`.** The most common failure. The reviewer subagent has no shared context with you and will catch shortcuts, stubs, half-implementations, and "looks plausible" output. Each rejection burns an iteration.
- **Calling `goal_update` early.** It will refuse cleanly with the list of incomplete subgoals, but it's a wasted call. Wait until every `subgoal_complete` returns APPROVED.
- **Goal proliferation.** One active goal per project directory. If the user asks for a new goal while one is active, surface that — don't silently abandon the old one.
- **Hook stuckness.** If the Stop hook keeps firing on the same subgoal and you have nothing left to try, that's a signal the subgoal is genuinely stuck. Call `subgoal_complete` and let the reviewer flag it as `BLOCKED`, or surface to the user — do not call `goal_update` to escape the loop.
