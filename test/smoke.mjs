#!/usr/bin/env node
// End-to-end smoke test: simulate a full v0.2 lifecycle in a tmp git repo.
// No subprocess mocking is needed because decomposition and review are
// driven by the caller in the real flow — we just pass the planner output
// directly as the `subgoals` arg, and the reviewer verdict directly as
// `subgoal_submit_review` args.

import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverScript = path.join(repoRoot, "bin/goal-server.mjs");

const PLANNER_OUTPUT = JSON.stringify({
  subgoals: [
    { id: "a", title: "Write file 1", description: "create file1.txt", done_criteria: "file exists", depends_on: [] },
    { id: "b", title: "Write file 2", description: "create file2.txt", done_criteria: "file exists", depends_on: ["a"] },
  ],
});

let failed = false;
function check(name, ok, detail = "") {
  const tag = ok ? "✓" : "✗";
  console.log(`  ${tag} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed = true;
}

async function main() {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "agenc-smoke-"));
  const projectDir = path.join(tmpRoot, "project");
  const dbPath = path.join(tmpRoot, "goals.json");
  await mkdir(projectDir);

  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: projectDir });
  spawnSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: projectDir });

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  async function withClient(env, fn) {
    const transport = new StdioClientTransport({
      command: "node",
      args: [serverScript],
      env: { ...process.env, ...env },
      cwd: projectDir,
    });
    const client = new Client({ name: "smoke", version: "0" }, { capabilities: {} });
    await client.connect(transport);
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  }

  const baseEnv = {
    AGENC_GOAL_DB_PATH: dbPath,
    CLAUDE_PROJECT_DIR: projectDir,
  };

  console.log("\n=== smoke test: full v0.2 lifecycle ===\n");

  // === Step 0: goal_create without subgoals errors with planner instructions ===
  // Done before any goal is active so the active-goal-exists check doesn't fire first.
  await withClient(baseEnv, async (c) => {
    const r = await c.callTool({
      name: "goal_create",
      arguments: { objective: "needs decompose" },
    });
    check("goal_create without subgoals errors", r.isError);
    check("error mentions goal-planner subagent", /goal-planner/.test(r.content[0].text));
  });

  // === Step 1: goal_create with pre-decomposed subgoals ===
  await withClient(baseEnv, async (c) => {
    const r = await c.callTool({
      name: "goal_create",
      arguments: { objective: "Write two files", subgoals: PLANNER_OUTPUT },
    });
    check("goal_create succeeds with subgoals arg", !r.isError, r.content[0].text.slice(0, 100));
    check("decomposition message mentions 2 subgoals", /2 subgoals/.test(r.content[0].text));
  });

  // === Step 2: subgoal_start sg-1 ===
  await withClient(baseEnv, async (c) => {
    const r = await c.callTool({ name: "subgoal_start", arguments: {} });
    check("subgoal_start succeeds", !r.isError);
    check("sg-1 starts on agenc-goal branch", /Branch: agenc-goal/.test(r.content[0].text));
  });

  const currentBranch1 = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectDir, encoding: "utf8" }).stdout.trim();
  check("git is now on subgoal branch", /^agenc-goal\//.test(currentBranch1), `current=${currentBranch1}`);

  // === Step 3: write file, commit, request review ===
  await writeFile(path.join(projectDir, "file1.txt"), "first file content\n");
  spawnSync("git", ["add", "."], { cwd: projectDir });
  spawnSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "-m", "wrote file1"], { cwd: projectDir });

  await withClient(baseEnv, async (c) => {
    const r = await c.callTool({ name: "subgoal_complete", arguments: {} });
    check("subgoal_complete returns REVIEW_NEEDED on first call", !r.isError);
    check("response contains REVIEW_NEEDED marker", /REVIEW_NEEDED/.test(r.content[0].text));
    check("response embeds the review payload", /BEGIN REVIEW PAYLOAD[\s\S]*END REVIEW PAYLOAD/.test(r.content[0].text));

    // subgoal should now be review_pending
    const list = await c.callTool({ name: "subgoal_list" });
    check("sg-1 transitioned to review_pending", /\[\?\] sg-1/.test(list.content[0].text));
  });

  // === Step 3b: subgoal_complete idempotent re-emit ===
  await withClient(baseEnv, async (c) => {
    const r = await c.callTool({ name: "subgoal_complete", arguments: {} });
    check("subgoal_complete on review_pending re-emits payload", !r.isError && /re-emitted/.test(r.content[0].text));
    const sg = await c.callTool({ name: "subgoal_get", arguments: { id: "sg-1" } });
    const parsed = JSON.parse(sg.content[0].text);
    check("iteration count NOT incremented on re-emit", parsed.iteration_count === 1, `iter=${parsed.iteration_count}`);
  });

  // === Step 4: submit NEEDS_REVISION ===
  await withClient(baseEnv, async (c) => {
    const r = await c.callTool({
      name: "subgoal_submit_review",
      arguments: { verdict: "NEEDS_REVISION", reasoning: "needs work" },
    });
    check("subgoal_submit_review NEEDS_REVISION returns isError", r.isError);
    check("response mentions NEEDS_REVISION", /NEEDS_REVISION/.test(r.content[0].text));
    const list = await c.callTool({ name: "subgoal_list" });
    check("sg-1 back to in_progress after NEEDS_REVISION", /\[~\] sg-1/.test(list.content[0].text));
  });

  // === Step 5: fix, commit, re-request review, submit APPROVED ===
  await writeFile(path.join(projectDir, "file1.txt"), "first file, fixed content\n");
  spawnSync("git", ["add", "."], { cwd: projectDir });
  spawnSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "-m", "fixed file1"], { cwd: projectDir });

  await withClient(baseEnv, async (c) => {
    const r = await c.callTool({ name: "subgoal_complete", arguments: {} });
    check("second subgoal_complete returns REVIEW_NEEDED", !r.isError && /REVIEW_NEEDED/.test(r.content[0].text));

    const submit = await c.callTool({
      name: "subgoal_submit_review",
      arguments: { verdict: "APPROVED", reasoning: "looks good" },
    });
    check("submit APPROVED succeeds", !submit.isError, submit.content[0].text.slice(0, 100));
    check("response mentions APPROVED + merged", /APPROVED.*merged/s.test(submit.content[0].text));
  });

  const currentBranchAfterMerge = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectDir, encoding: "utf8" }).stdout.trim();
  check("git returned to main after merge", currentBranchAfterMerge === "main");

  // === Step 6: parse-from-reviewer-output path ===
  await withClient(baseEnv, async (c) => {
    const r = await c.callTool({ name: "subgoal_start", arguments: {} });
    check("sg-2 starts (next eligible)", !r.isError && /sg-2/.test(r.content[0].text));
  });

  await writeFile(path.join(projectDir, "file2.txt"), "second file content\n");
  spawnSync("git", ["add", "."], { cwd: projectDir });
  spawnSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "-m", "wrote file2"], { cwd: projectDir });

  await withClient(baseEnv, async (c) => {
    await c.callTool({ name: "subgoal_complete", arguments: {} });
    const submit = await c.callTool({
      name: "subgoal_submit_review",
      arguments: {
        reviewer_output: "Reasoning paragraph about the diff.\n\nVERDICT: APPROVED",
      },
    });
    check("submit via reviewer_output APPROVED succeeds", !submit.isError, submit.content[0].text.slice(0, 100));
  });

  await withClient(baseEnv, async (c) => {
    const list = await c.callTool({ name: "subgoal_list" });
    check("both subgoals complete in final list", /\[x\] sg-1.*\[x\] sg-2/s.test(list.content[0].text));

    const r = await c.callTool({ name: "goal_update", arguments: { status: "complete" } });
    check("goal_update succeeds when all subgoals complete", !r.isError, r.content[0].text);
  });

  const log = spawnSync("git", ["log", "--first-parent", "--oneline", "main"], { cwd: projectDir, encoding: "utf8" }).stdout;
  const mergeCount = (log.match(/Merge subgoal/g) || []).length;
  check("main has exactly 2 subgoal merge commits", mergeCount === 2, `mergeCount=${mergeCount}`);

  await withClient(baseEnv, async (c) => {
    const r = await c.callTool({ name: "goal_get" });
    const goal = JSON.parse(r.content[0].text);
    check("final goal status is complete", goal.status === "complete");
  });

  // === goal_clear ===
  await withClient(baseEnv, async (c) => {
    const r1 = await c.callTool({
      name: "goal_create",
      arguments: { objective: "Goal to abandon", subgoals: PLANNER_OUTPUT },
    });
    check("can create goal after previous one was completed", !r1.isError);
    const r2 = await c.callTool({ name: "goal_clear", arguments: {} });
    check("goal_clear succeeds", !r2.isError);
    check("goal_clear message mentions cleared", /cleared/.test(r2.content[0].text));
    const r3 = await c.callTool({ name: "goal_get" });
    check("goal_get reports no goal after clear", /No goal exists/.test(r3.content[0].text));
  });

  // === iteration cap ===
  await withClient(
    { ...baseEnv, AGENC_GOAL_MAX_ITERATIONS: "2" },
    async (c) => {
      await c.callTool({
        name: "goal_create",
        arguments: { objective: "Iter cap test", subgoals: PLANNER_OUTPUT },
      });
      await c.callTool({ name: "subgoal_start", arguments: {} });
      const fs = await import("node:fs/promises");
      await fs.writeFile(path.join(projectDir, "iter.txt"), "x");
      spawnSync("git", ["add", "."], { cwd: projectDir });
      spawnSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "-m", "iter1"], { cwd: projectDir });

      // iter 1
      const r1 = await c.callTool({ name: "subgoal_complete", arguments: {} });
      check("iter 1 returns REVIEW_NEEDED", !r1.isError && /REVIEW_NEEDED/.test(r1.content[0].text));
      const submit1 = await c.callTool({
        name: "subgoal_submit_review",
        arguments: { verdict: "NEEDS_REVISION", reasoning: "fail 1" },
      });
      check("iter 1 NEEDS_REVISION", submit1.isError && /NEEDS_REVISION/.test(submit1.content[0].text));

      // iter 2
      const r2 = await c.callTool({ name: "subgoal_complete", arguments: {} });
      check("iter 2 returns REVIEW_NEEDED", !r2.isError && /REVIEW_NEEDED/.test(r2.content[0].text));
      const submit2 = await c.callTool({
        name: "subgoal_submit_review",
        arguments: { verdict: "NEEDS_REVISION", reasoning: "fail 2" },
      });
      check("iter 2 NEEDS_REVISION", submit2.isError && /NEEDS_REVISION/.test(submit2.content[0].text));

      // iter 3 — exceeds cap of 2 inside subgoal_complete
      const r3 = await c.callTool({ name: "subgoal_complete", arguments: {} });
      check("iter 3 exceeds cap, auto-blocked", r3.isError && /Iteration cap.*exceeded/i.test(r3.content[0].text));

      await c.callTool({ name: "goal_clear" });
    },
  );

  // === unparseable submit_review treated as NEEDS_REVISION ===
  await withClient(baseEnv, async (c) => {
    await c.callTool({
      name: "goal_create",
      arguments: { objective: "Unparseable test", subgoals: PLANNER_OUTPUT },
    });
    await c.callTool({ name: "subgoal_start", arguments: {} });
    const fs = await import("node:fs/promises");
    await fs.writeFile(path.join(projectDir, "unparseable.txt"), "x");
    spawnSync("git", ["add", "."], { cwd: projectDir });
    spawnSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "-m", "unparseable"], { cwd: projectDir });
    await c.callTool({ name: "subgoal_complete", arguments: {} });

    const submit = await c.callTool({
      name: "subgoal_submit_review",
      arguments: { reviewer_output: "no verdict line in this output" },
    });
    check(
      "unparseable submit treated as NEEDS_REVISION",
      submit.isError && /NEEDS_REVISION/.test(submit.content[0].text),
    );
    await c.callTool({ name: "goal_clear" });
  });

  await rm(tmpRoot, { recursive: true, force: true });

  console.log(`\n=== ${failed ? "FAILED" : "PASSED"} ===\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(1);
});
