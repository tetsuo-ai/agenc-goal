// Planner output parsing + subgoal normalization.
//
// Decomposition itself runs as a subagent in the parent Claude Code
// session — see agents/goal-planner.md. The MCP server never spawns a
// claude subprocess. The skill invokes the goal-planner subagent and
// passes the raw output (or a parsed array) to goal_create as the
// `subgoals` argument; goal_create normalizes through the helpers
// here.
//
// Any failure (malformed JSON, missing fields) degenerates to a single
// subgoal mirroring the original objective — better to under-decompose
// silently than to fail the goal_create call.

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

// Resolve whatever the caller passed as `subgoals` into a normalized
// array of subgoal records. Accepts:
//   - an array of subgoal objects
//   - a JSON string containing {"subgoals":[...]}
//   - a JSON string containing a bare array
//   - raw subagent text with a JSON object somewhere inside (parsed
//     best-effort via parsePlannerOutput)
//
// Returns null if no parseable subgoal list could be extracted; the
// caller should fall back to a single-subgoal degenerate.
export function resolveSubgoals(input) {
  if (Array.isArray(input)) return input.length > 0 ? input : null;

  if (typeof input === "string") {
    const parsed = parsePlannerOutput(input);
    if (parsed) {
      if (Array.isArray(parsed)) return parsed.length > 0 ? parsed : null;
      if (Array.isArray(parsed.subgoals) && parsed.subgoals.length > 0) {
        return parsed.subgoals;
      }
    }
    return null;
  }

  if (input && typeof input === "object" && Array.isArray(input.subgoals)) {
    return input.subgoals.length > 0 ? input.subgoals : null;
  }

  return null;
}

export function normalize(rawSubgoals, objective) {
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
export function breakCycles(subgoals) {
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

export function singletonSubgoal(objective) {
  return {
    id: "sg-1",
    title: objective.slice(0, 80),
    description: objective,
    done_criteria: "User confirms the work is done.",
    depends_on: [],
  };
}
