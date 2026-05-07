# agenc

A Claude Code plugin for running multi-step goals with automatic decomposition, per-subgoal correctness gates, and a reviewer subagent that audits each subgoal before it can be marked complete.

## What it does

Type `/agenc:goal <objective>` and four things wire up automatically:

1. **A planner subprocess** decomposes the objective into as many subgoals as the work needs (atomic objectives stay as one). Cycles in declared dependencies are auto-broken; the planner can't wedge the goal.
2. **An MCP-backed goal store** persists state at `~/.agenc/agenc-goals.json`, scoped per project directory. One active goal per project. Survives session restarts. O_EXCL lock for concurrent writers.
3. **A continuation Stop hook.** When the model would otherwise stop, the hook returns a completion-audit prompt scoped to the current subgoal (not the whole goal — much sharper). All reflected planner/reviewer text is wrapped in `<untrusted>` tags with XML-escaped content so subprocess output can't inject instructions into your session.
4. **Per-subgoal isolation + reviewer audit.** Each subgoal runs on its own git branch (`agenc-goal/<short>/<sg-N>`). When the model calls `subgoal_complete`, the plugin runs the project's gates (auto-detected or user-defined), then spawns a reviewer subagent that audits the diff. Only after `APPROVED` is the branch merged back. After `AGENC_GOAL_MAX_ITERATIONS` consecutive `NEEDS_REVISION` cycles (default 10), the subgoal auto-transitions to `blocked` for human intervention.

Eight tools are exposed to the model:

- `goal_create({objective, decompose?})` — start a goal.
- `goal_get()` — inspect the active goal.
- `goal_update({status: "complete"})` — close the goal. Refuses unless every subgoal is complete.
- `goal_clear()` — abandon and delete the active goal entirely.
- `subgoal_list()` — one-line-per-subgoal summary.
- `subgoal_get({id?})` — full record for one subgoal.
- `subgoal_start({id?})` — begin a subgoal; creates the branch.
- `subgoal_complete({id?})` — run gates + reviewer. Returns APPROVED, NEEDS_REVISION, or BLOCKED.

## Install

In a Claude Code session:

```
/plugin marketplace add tetsuo-ai/agenc-goal
/plugin install agenc@tetsuo-ai
```

After install, run `npm install` once inside the plugin directory (Claude Code does not auto-install npm dependencies):

```bash
cd ~/.claude/plugins/agenc
npm install
```

Restart Claude Code (or run `/reload-plugins`). The slash command `/agenc:goal` is now available.

For local development without the marketplace, clone and launch directly:

```bash
git clone https://github.com/tetsuo-ai/agenc-goal
cd agenc-goal && npm install
claude --plugin-dir .
```

## Use

Start a multi-step goal (default — decompose into subgoals):

```
/agenc:goal port the legacy auth module to the new shape
```

The planner returns N subgoals. Claude works each one in sequence: starts a subgoal, makes the changes on its branch, calls `subgoal_complete` to run gates and the reviewer, fixes any rejections, then advances to the next subgoal.

Start a single-objective goal (skip the planner):

```
/agenc:goal --no-plan write a sentence about cats in cats.txt
```

Check status:

```
/agenc:goal
```

(no arguments — calls `goal_get` and reports current state)

Abandon a goal:

```
/agenc:goal clear
```

(or have the model call `goal_clear` directly)

## Configuring gates

Gates are correctness checks that run before the reviewer is consulted. The plugin auto-detects gates from project markers:

| Marker | Gate emitted |
|---|---|
| `package.json` `scripts.test` | `npm test` |
| `package.json` `scripts.lint` | `npm run lint` |
| `package.json` `scripts.typecheck` | `npm run typecheck` |
| `pyproject.toml` or `pytest.ini` | `pytest` |
| `Cargo.toml` | `cargo test` |
| `go.mod` | `go test ./...` |
| `Makefile` with `test:` | `make test` |

To override, drop `.agenc/gates.json` in the project root:

```json
{
  "gates": [
    {"name": "tests", "cmd": "npm test", "timeout_ms": 600000},
    {"name": "lint", "cmd": "npm run lint"}
  ],
  "default_timeout_ms": 300000
}
```

When `.agenc/gates.json` exists, only its gates run — auto-detection is skipped.

## Environment variables

All defaults are deadlock-recovery / OOM-prevention limits, not policy. Override only if you hit them.

| Variable | Default | What it caps |
|---|---|---|
| `AGENC_GOAL_DB_PATH` | `~/.agenc/agenc-goals.json` | Storage location |
| `AGENC_GOAL_MAX_ITERATIONS` | `10` | NEEDS_REVISION cycles before auto-blocked |
| `AGENC_GOAL_PLANNER_TIMEOUT_MS` | `90_000` | Planner subprocess hang detection |
| `AGENC_GOAL_REVIEWER_TIMEOUT_MS` | `180_000` | Reviewer subprocess hang detection |
| `AGENC_GOAL_GATE_TIMEOUT_MS` | `600_000` | Default per-gate command hang detection |
| `AGENC_GOAL_MAX_DIFF_BYTES` | `204_800` (200KB) | Diff size sent to reviewer |
| `AGENC_GOAL_OUTPUT_TAIL_BYTES` | `4096` | Gate stdout/stderr captured |

## Architecture

The pattern mirrors a `/goal` autonomy loop from terminal coding agents — persistent objective, model-callable completion tool, idle-trigger continuation, resume-on-restore — but adds the gate + reviewer audit pipeline that catches premature completion. Without the reviewer, agents tend to mark half-done work as complete ~30% of the time.

| Feature | Implementation |
|---|---|
| Persistent state | JSON file at `${CLAUDE_PLUGIN_DATA}/agenc-goals.json`, O_EXCL lock file for concurrent writers |
| Subgoal decomposition | `claude -p --bare` subprocess; planner emits N subgoals; cycles broken via Kahn's algorithm; degenerate single-subgoal fallback on parse/auth failure |
| Continuation trigger | Stop hook returning `decision="block"` with state-aware reason text |
| Session resume | SessionStart hook injecting `additionalContext` with current subgoal + last reviewer verdict |
| Subgoal isolation | Per-subgoal git branch; branch ops + state flip atomic under DB lock; `--no-ff` merge on approval |
| Correctness gates | Auto-detect from project markers, override via `.agenc/gates.json`, tail-truncated stdout/stderr |
| Reviewer audit | `claude -p --bare` subprocess; checks `is_error` envelope; scans last 5 non-empty lines for `VERDICT:` regex; defaults to NEEDS_REVISION on any parse failure (never default open) |
| Completion signal | Model calls `goal_update` MCP tool; refuses if subgoals not complete |
| Iteration cap | After N consecutive NEEDS_REVISION on the same subgoal, auto-transition to blocked with synthetic verdict |
| Prompt-injection defense | All planner/reviewer/objective fields wrapped via `lib/text.mjs` `untrusted()` — `<untrusted>...</untrusted>` tags with XML-escaped body |

## Project layout

```
agenc-goal/
├── .claude-plugin/
│   └── plugin.json              ← plugin manifest
├── .mcp.json                    ← MCP server registration (auto-discovered)
├── hooks/
│   └── hooks.json               ← Stop + SessionStart wiring (auto-discovered)
├── bin/
│   └── goal-server.mjs          ← MCP server (8 tools, JSON-backed)
├── lib/
│   ├── db.mjs                   ← JSON store with O_EXCL lock
│   ├── text.mjs                 ← XML-escape + untrusted-content wrapper
│   ├── planner.mjs              ← decomposition subprocess + cycle-break
│   ├── reviewer.mjs             ← audit subprocess + verdict parser
│   ├── gate-runner.mjs          ← auto-detect + run gates
│   └── branch-helper.mjs        ← per-subgoal git branches
├── commands/
│   └── goal.md                  ← /agenc:goal smart-parse command
├── scripts/
│   ├── on-stop.mjs              ← state-aware continuation
│   └── on-session-start.mjs     ← resume-restore
├── skills/
│   └── goal/SKILL.md            ← workflow doc
├── test/
│   ├── smoke.mjs                ← end-to-end test (mocked subprocesses)
│   └── unit/                    ← node --test unit suites
├── package.json
├── README.md
├── llms.txt
└── LICENSE
```

## License

MIT
