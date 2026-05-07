// Missing or invalid verdict → NEEDS_REVISION. Never default to APPROVED:
// the reviewer's whole purpose is to catch premature completion, and a
// parse failure must not auto-approve.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { findClaudeBin } from "./claude-bin.mjs";

const REVIEWER_HANG_TIMEOUT_MS = parseInt(process.env.AGENC_GOAL_REVIEWER_TIMEOUT_MS) || 180_000;
const MAX_DIFF_BYTES = parseInt(process.env.AGENC_GOAL_MAX_DIFF_BYTES) || 200 * 1024;

const REVIEWER_SYSTEM_PROMPT = `You are a senior reviewer auditing one subgoal of a larger objective.

The implementer believes this subgoal is complete. Decide independently whether they are right. Be skeptical:

- Does the diff actually implement the description, end-to-end?
- Are there shortcuts, stubs, placeholders, or premature short-circuits?
- Did the gate results pass meaningfully, or pass because the test set was empty?
- Are there gaps the user would not accept if they were reviewing this themselves?

Write your reasoning in 1-3 paragraphs identifying specific evidence (file paths, line snippets, gate output) — not vague impressions.

On the LAST LINE, return EXACTLY ONE OF:
VERDICT: APPROVED
VERDICT: NEEDS_REVISION
VERDICT: BLOCKED

Use APPROVED only when the subgoal is genuinely done. Use NEEDS_REVISION when the implementation has fixable gaps; identify them specifically. Use BLOCKED only when the subgoal cannot proceed (missing dependency, ambiguous spec, external blocker).`;

export async function review({ objective, subgoal, diff, gate_results }) {
  if (process.env.AGENC_GOAL_MOCK === "1") {
    if (process.env.AGENC_GOAL_MOCK_REVIEWER_FILE) {
      try {
        const data = JSON.parse(await readFile(process.env.AGENC_GOAL_MOCK_REVIEWER_FILE, "utf8"));
        return { verdict: data.verdict, reasoning: data.reasoning || "" };
      } catch {}
    }
    const overrideVerdict = process.env.AGENC_GOAL_MOCK_REVIEWER || "APPROVED";
    return { verdict: overrideVerdict, reasoning: "(mock reviewer)" };
  }

  const payload = buildPayload({ objective, subgoal, diff, gate_results });
  const result = await invokeClaude(payload);
  if (!result.ok) {
    return {
      verdict: "NEEDS_REVISION",
      reasoning: `Reviewer subprocess failed: ${result.error}\n\nTo debug, run this in your terminal:\n  echo test | claude -p --output-format json --allowed-tools "" --effort medium\n\nIf that works but the plugin doesn't, the MCP server's PATH likely doesn't include the claude binary. Set AGENC_GOAL_CLAUDE_BIN to the absolute path of claude in the .mcp.json env block.`,
    };
  }
  const text = result.text;

  const verdict = parseVerdict(text);
  if (verdict === null) {
    return {
      verdict: "NEEDS_REVISION",
      reasoning: `Reviewer output did not contain a parseable VERDICT line. Treating as needs-revision. Output excerpt:\n${text.slice(0, 1000)}`,
    };
  }
  return { verdict, reasoning: extractReasoning(text) };
}

function buildPayload({ objective, subgoal, diff, gate_results }) {
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

function invokeClaude(payload) {
  return new Promise((resolve) => {
    const claudeBin = findClaudeBin();
    const claude = spawn(claudeBin, [
      "-p",
      "--system-prompt", REVIEWER_SYSTEM_PROMPT,
      "--output-format", "json",
      "--allowed-tools", "",
      "--effort", "medium",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: REVIEWER_HANG_TIMEOUT_MS,
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
        process.stderr.write(`[agenc-goal reviewer] ${msg}\n`);
        return resolve({ ok: false, error: msg });
      }
      try {
        const env = JSON.parse(stdout);
        if (env.is_error) {
          const msg = `subprocess returned is_error=true. result: ${(env.result || stdout).slice(0, 1500)}`;
          process.stderr.write(`[agenc-goal reviewer] ${msg}\n`);
          return resolve({ ok: false, error: msg });
        }
        resolve({ ok: true, text: env.result || env.text || stdout });
      } catch {
        resolve({ ok: true, text: stdout });
      }
    });
    claude.on("error", (err) => {
      const msg = `[claude bin: ${claudeBin}] spawn error: ${err.message}`;
      process.stderr.write(`[agenc-goal reviewer] ${msg}\n`);
      resolve({ ok: false, error: msg });
    });

    claude.stdin.write(payload);
    claude.stdin.end();
  });
}

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

function extractReasoning(text) {
  return text.replace(/\n*^VERDICT:\s+(APPROVED|NEEDS_REVISION|BLOCKED)\s*$/m, "").trim();
}
