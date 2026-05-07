---
description: Start, view, or work toward a project goal. Pass an objective to start; no args shows status.
---

If `$ARGUMENTS` is empty: call the `goal_get` tool and report the active goal's objective, status, elapsed time, and (if it has subgoals) the subgoal progress. If no goal exists, say so.

Otherwise: parse `$ARGUMENTS` for a `--no-plan` flag.

- If `--no-plan` is present: strip it from the arguments and call `goal_create` with `objective="<remaining>"` and `decompose=false`. Run as a single objective. After the goal is created, take the first concrete step toward it. Do not stop until the objective is achieved end-to-end, then call `goal_update` with `status="complete"`.

- Otherwise (default): call `goal_create` with `objective="$ARGUMENTS"` (decomposition enabled). The planner will return subgoals. After the goal is created:
  1. Call `subgoal_start` (no id — picks the next eligible subgoal) to begin the first subgoal.
  2. Work toward the subgoal's done criteria.
  3. When done, call `subgoal_complete` (no id — completes the in-progress subgoal). Gates and the reviewer subagent run automatically. The result is `APPROVED`, `NEEDS_REVISION`, or `BLOCKED`.
  4. If `APPROVED`: call `subgoal_start` again to advance to the next subgoal. Repeat from step 2.
  5. If `NEEDS_REVISION`: address the reviewer's feedback (returned in the tool result), then call `subgoal_complete` again.
  6. If `BLOCKED`: surface the blocker to the user and stop.
  7. After all subgoals are complete: call `goal_update` with `status="complete"` to close the goal.

While any subgoal is in progress, the Stop hook will keep firing scoped completion-audit prompts. Do not mark a subgoal complete based on partial progress, plausible-looking output, or articulate summaries — the reviewer subagent will reject premature claims and you'll lose an iteration.
