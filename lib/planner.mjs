// Any failure (non-zero exit, malformed JSON, missing fields) degenerates
// to a single subgoal mirroring the original objective — better to
// under-decompose silently than to fail the goal_create call.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { findClaudeBin } from "./claude-bin.mjs";

const PLANNER_HANG_TIMEOUT_MS = parseInt(process.env.AGENC_GOAL_PLANNER_TIMEOUT_MS) || 90_000;

const PLANNER_SYSTEM_PROMPT = `You decompose a user's objective into a sequence of subgoals. Use as many as the work genuinely requires — don't compress real multi-step work into one subgoal, and don't fabricate steps for atomic work.

For each subgoal:
- id: stable identifier of the form "sg-1", "sg-2", ...
- title: short title (5-10 words)
- description: 1-2 sentences describing what success looks like
- done_criteria: objective and verifiable (e.g., "tests pass", "file exists with X content")
- depends_on: array of prior subgoal ids that must complete first ([] if none)

Each subgoal should be a unit of work small enough that a reviewer can audit its diff in isolation, but large enough to represent meaningful progress. If the objective is atomic (e.g. "write a sentence about cats"), return EXACTLY ONE subgoal.

Return ONLY a single JSON object on its own line, no prose, no markdown fences:
{"subgoals":[{"id":"sg-1","title":"...","description":"...","done_criteria":"...","depends_on":[]}]}`;

export async function plan(objective) {
  if (process.env.AGENC_GOAL_MOCK === "1") {
    if (process.env.AGENC_GOAL_MOCK_PLANNER) {
      try {
        const data = JSON.parse(await readFile(process.env.AGENC_GOAL_MOCK_PLANNER, "utf8"));
        return { subgoals: normalize(data.subgoals, objective) };
      } catch {}
    }
    return { subgoals: [singletonSubgoal(objective)] };
  }

  const result = await invokeClaude(objective);
  if (!result.ok) {
    return { subgoals: [singletonSubgoal(objective)], error: result.error };
  }

  const parsed = parsePlannerOutput(result.text);
  if (!parsed || !Array.isArray(parsed.subgoals) || parsed.subgoals.length === 0) {
    return { subgoals: [singletonSubgoal(objective)] };
  }
  return { subgoals: normalize(parsed.subgoals, objective) };
}

function normalize(rawSubgoals, objective) {
  const idMap = new Map();
  const out = rawSubgoals.map((sg, i) => {
    const newId = `sg-${i + 1}`;
    idMap.set(sg.id, newId);
    return {
      id: newId,
      title: String(sg.title || "").slice(0, 200) || `Subgoal ${i + 1}`,
      description: String(sg.description || "").slice(0, 1000) || objective,
      done_criteria: String(sg.done_criteria || "").slice(0, 500) || "User confirms the work is done.",
      depends_on: Array.isArray(sg.depends_on) ? sg.depends_on : [],
    };
  });
  for (const sg of out) {
    sg.depends_on = sg.depends_on
      .map((d) => idMap.get(d))
      .filter((d) => typeof d === "string");
  }
  breakCycles(out);
  return out;
}

// Kahn's algorithm: detect any subgoal participating in a dependency
// cycle and clear its depends_on. Preserve all subgoals.
function breakCycles(subgoals) {
  const ids = new Set(subgoals.map((sg) => sg.id));
  const indegree = new Map();
  for (const sg of subgoals) {
    indegree.set(sg.id, 0);
  }
  for (const sg of subgoals) {
    for (const d of sg.depends_on) {
      if (ids.has(d)) {
        indegree.set(sg.id, (indegree.get(sg.id) || 0) + 1);
      }
    }
  }
  const queue = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) queue.push(id);
  }
  const removed = new Set();
  while (queue.length > 0) {
    const id = queue.shift();
    removed.add(id);
    for (const sg of subgoals) {
      if (removed.has(sg.id)) continue;
      if (sg.depends_on.includes(id)) {
        indegree.set(sg.id, indegree.get(sg.id) - 1);
        if (indegree.get(sg.id) === 0) queue.push(sg.id);
      }
    }
  }
  for (const sg of subgoals) {
    if (!removed.has(sg.id)) {
      sg.depends_on = [];
    }
  }
}

function singletonSubgoal(objective) {
  return {
    id: "sg-1",
    title: objective.slice(0, 80),
    description: objective,
    done_criteria: "User confirms the work is done.",
    depends_on: [],
  };
}

function invokeClaude(objective) {
  return new Promise((resolve) => {
    const claudeBin = findClaudeBin();
    const claude = spawn(claudeBin, [
      "-p",
      "--system-prompt", PLANNER_SYSTEM_PROMPT,
      "--output-format", "json",
      "--allowed-tools", "",
      "--effort", "low",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: PLANNER_HANG_TIMEOUT_MS,
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    claude.stdout.on("data", (b) => stdoutChunks.push(b));
    claude.stderr.on("data", (b) => stderrChunks.push(b));

    claude.on("close", (code) => {
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      if (code !== 0) {
        const msg = `[claude bin: ${claudeBin}] subprocess exited ${code}. stderr: ${stderr.slice(-1500) || "(empty)"}`;
        process.stderr.write(`[agenc-goal planner] ${msg}\n`);
        return resolve({ ok: false, error: msg });
      }
      try {
        const env = JSON.parse(stdout);
        if (env.is_error) {
          const msg = `subprocess returned is_error=true. result: ${(env.result || stdout).slice(0, 1500)}`;
          process.stderr.write(`[agenc-goal planner] ${msg}\n`);
          return resolve({ ok: false, error: msg });
        }
        resolve({ ok: true, text: env.result || env.text || stdout });
      } catch {
        resolve({ ok: true, text: stdout });
      }
    });
    claude.on("error", (err) => {
      const msg = `[claude bin: ${claudeBin}] spawn error: ${err.message}`;
      process.stderr.write(`[agenc-goal planner] ${msg}\n`);
      resolve({ ok: false, error: msg });
    });

    claude.stdin.write(objective);
    claude.stdin.end();
  });
}

export function parsePlannerOutput(text) {
  if (!text || typeof text !== "string") return null;
  try { return JSON.parse(text); } catch {}

  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]+?\})\s*```/);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
}
