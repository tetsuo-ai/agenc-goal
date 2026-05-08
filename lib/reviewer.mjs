// Review payload construction + verdict parsing for the two-phase
// subgoal_complete / subgoal_submit_review flow.
//
// The reviewer itself runs as a subagent in the parent Claude Code
// session — see agents/goal-reviewer.md. The MCP server never spawns a
// claude subprocess; it builds the payload here, returns it to the
// caller, and parses the verdict the caller submits back.

const MAX_DIFF_BYTES = parseInt(process.env.AGENC_GOAL_MAX_DIFF_BYTES) || 200 * 1024;

export function buildReviewPayload({ objective, subgoal, diff, gate_results }) {
  const gateLines = (gate_results || []).map(formatGateResult).join("\n\n");
  const diffText = truncateDiff(diff || "(no diff captured)");
  return [
    `Top objective: ${objective}`,
    ``,
    `Subgoal under review:`,
    `- Title: ${subgoal.title}`,
    `- Description: ${subgoal.description}`,
    `- Done criteria: ${subgoal.done_criteria}`,
    ``,
    `Gate results:`,
    gateLines || "(no gates configured for this project)",
    ``,
    `Diff (vs parent branch):`,
    "```diff",
    diffText,
    "```",
  ].join("\n");
}

function truncateDiff(diff) {
  const totalBytes = Buffer.byteLength(diff, "utf8");
  if (totalBytes <= MAX_DIFF_BYTES) return diff;
  const buf = Buffer.from(diff, "utf8");
  const head = buf.subarray(0, MAX_DIFF_BYTES).toString("utf8");
  const remaining = totalBytes - MAX_DIFF_BYTES;
  return `${head}\n... [diff truncated, ${remaining} more bytes]`;
}

function formatGateResult(r) {
  const head = `[${r.exit === 0 ? "PASS" : "FAIL"}] ${r.name} (${r.cmd}) — exit=${r.exit}, ${r.ms}ms`;
  const out = r.stdout ? `stdout:\n${r.stdout}` : "";
  const err = r.stderr ? `stderr:\n${r.stderr}` : "";
  return [head, out, err].filter(Boolean).join("\n");
}

// Missing or invalid verdict → NEEDS_REVISION. Never default to APPROVED:
// the reviewer's whole purpose is to catch premature completion, and a
// parse failure must not auto-approve.
export function parseVerdict(text) {
  if (!text || typeof text !== "string") return null;
  const lines = text.trim().split(/\r?\n/);
  let nonEmptyCount = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const m = /^VERDICT:\s+(APPROVED|NEEDS_REVISION|BLOCKED)\s*$/.exec(line);
    if (m) return m[1];
    if (++nonEmptyCount >= 5) return null;
  }
  return null;
}

export function extractReasoning(text) {
  if (!text || typeof text !== "string") return "";
  return text.replace(/\n*^VERDICT:\s+(APPROVED|NEEDS_REVISION|BLOCKED)\s*$/m, "").trim();
}

// Normalize a verdict object received from subgoal_submit_review.
// Returns { verdict, reasoning } or null if neither form is parseable.
//
// Accepts either:
// - { verdict: "APPROVED" | "NEEDS_REVISION" | "BLOCKED", reasoning?: string }
// - { reviewer_output: "...full subagent text..." } — verdict parsed from the last line
export function normalizeSubmittedVerdict(args) {
  if (!args || typeof args !== "object") return null;

  if (typeof args.verdict === "string") {
    const v = args.verdict.trim().toUpperCase();
    if (v !== "APPROVED" && v !== "NEEDS_REVISION" && v !== "BLOCKED") return null;
    return {
      verdict: v,
      reasoning: typeof args.reasoning === "string" ? args.reasoning.trim() : "",
    };
  }

  if (typeof args.reviewer_output === "string") {
    const v = parseVerdict(args.reviewer_output);
    if (!v) return null;
    return { verdict: v, reasoning: extractReasoning(args.reviewer_output) };
  }

  return null;
}
