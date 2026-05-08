---
description: Start, view, or work toward a project goal. Pass an objective to start; no args shows status.
---

If `$ARGUMENTS` is empty: call the `goal_get` tool and report the active goal's objective, status, elapsed time, and (if it has subgoals) the subgoal progress. If no goal exists, say so.

Otherwise: parse `$ARGUMENTS` for a `--no-plan` flag.

- If `--no-plan` is present: strip it from the arguments and call `goal_create` with `objective="<remaining>"` and `decompose=false`. Run as a single objective. After the goal is created, take the first concrete step toward it. Do not stop until the objective is achieved end-to-end, then call `goal_update` with `status="complete"`.

- Otherwise (default): decomposition is required. Do NOT call `goal_create` first.
  1. Invoke the `goal-planner` subagent (Task tool, `subagent_type="goal-planner"`). Pass the objective `$ARGUMENTS` verbatim as the prompt. The subagent returns a single JSON object of the form `{"subgoals":[...]}`.
  2. Call `goal_create({objective: "$ARGUMENTS", subgoals: "<raw subagent output>"})`. The MCP server parses and normalizes the subgoals.
  3. Call `subgoal_start` (no id — picks the next eligible subgoal) to begin the first subgoal.
  4. Work toward the subgoal's done criteria.
  5. When you believe the subgoal is done, call `subgoal_complete` (no id — completes the in-progress subgoal). The MCP server runs gates and returns a `REVIEW_NEEDED` payload between `--- BEGIN REVIEW PAYLOAD ---` and `--- END REVIEW PAYLOAD ---` markers.
  6. Invoke the `goal-reviewer` subagent (Task tool, `subagent_type="goal-reviewer"`). Pass the review payload (everything between the markers) as the prompt. The subagent's last line will be `VERDICT: APPROVED | NEEDS_REVISION | BLOCKED`.
  7. Call `subgoal_submit_review({reviewer_output: "<full subagent text>"})` to submit the verdict. The server parses the verdict from the last line and runs the post-review logic (merge on APPROVED, etc.). You may instead pass `{verdict, reasoning}` if you parsed the verdict yourself.
  8. If `APPROVED`: call `subgoal_start` again to advance to the next subgoal. Repeat from step 4.
  9. If `NEEDS_REVISION`: address the reviewer's feedback (returned in the tool result), then go back to step 4 (do another iteration of work, then call `subgoal_complete` again).
  10. If `BLOCKED`: surface the blocker to the user and stop.
  11. After all subgoals are complete: call `goal_update` with `status="complete"` to close the goal.

While any subgoal is in progress, the Stop hook will keep firing scoped completion-audit prompts. Do not skip the goal-reviewer subagent and self-approve — the reviewer is what catches premature completion.
