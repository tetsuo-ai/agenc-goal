#!/usr/bin/env node
// End-to-end smoke test: simulate a full v0.2 lifecycle in a tmp git repo
// using AGENC_GOAL_MOCK=1 to short-circuit the planner and reviewer
// subprocesses. No real claude API calls.

import { spawnSync, spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverScript = path.join(repoRoot, "bin/goal-server.mjs");

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
  const fixtureDir = path.join(tmpRoot, "fixtures");
  await mkdir(projectDir);
  await mkdir(fixtureDir);

  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: projectDir });
  spawnSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: projectDir });

  const plannerFixture = path.join(fixtureDir, "planner.json");
  await writeFile(plannerFixture, JSON.stringify({
    subgoals: [
      { id: "a", title: "Write file 1", description: "create file1.txt", done_criteria: "file exists", depends_on: [] },
      { id: "b", title: "Write file 2", description: "create file2.txt", done_criteria: "file exists", depends_on: ["a"] },
    ],
  }));

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

  console.log("\n=== smoke test: full v0.2 lifecycle ===\n");

  await withClient(
    {
      AGENC_GOAL_DB_PATH: dbPath,
      CLAUDE_PROJECT_DIR: projectDir,
      AGENC_GOAL_MOCK: "1",
      AGENC_GOAL_MOCK_PLANNER: plannerFixture,
    },
    async (c) => {
      const r = await c.callTool({ name: "goal_create", arguments: { objective: "Write two files" } });
      check("goal_create succeeds", !r.isError);
      check("decomposition message mentions 2 subgoals", /2 subgoals/.test(r.content[0].text), `text: ${r.content[0].text.slice(0, 100)}`);
    },
  );

  await withClient(
    { AGENC_GOAL_DB_PATH: dbPath, CLAUDE_PROJECT_DIR: projectDir, AGENC_GOAL_MOCK: "1", AGENC_GOAL_MOCK_PLANNER: plannerFixture },
    async (c) => {
      const r = await c.callTool({ name: "subgoal_start", arguments: {} });
      check("subgoal_start succeeds", !r.isError);
      check("sg-1 starts on agenc-goal branch", /Branch: agenc-goal/.test(r.content[0].text));
    },
  );

  const currentBranch1 = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectDir, encoding: "utf8" }).stdout.trim();
  check("git is now on subgoal branch", /^agenc-goal\//.test(currentBranch1), `current=${currentBranch1}`);

  await writeFile(path.join(projectDir, "file1.txt"), "first file content\n");
  spawnSync("git", ["add", "."], { cwd: projectDir });
  spawnSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "-m", "wrote file1"], { cwd: projectDir });

  await withClient(
    { AGENC_GOAL_DB_PATH: dbPath, CLAUDE_PROJECT_DIR: projectDir, AGENC_GOAL_MOCK: "1", AGENC_GOAL_MOCK_PLANNER: plannerFixture, AGENC_GOAL_MOCK_REVIEWER: "NEEDS_REVISION" },
    async (c) => {
      const r = await c.callTool({ name: "subgoal_complete", arguments: {} });
      check("subgoal_complete returns isError on NEEDS_REVISION", r.isError === true);
      check("response mentions NEEDS_REVISION", /NEEDS_REVISION/.test(r.content[0].text));
      const list = await c.callTool({ name: "subgoal_list" });
      check("sg-1 still in_progress after NEEDS_REVISION", /\[~\] sg-1/.test(list.content[0].text));
    },
  );

  await writeFile(path.join(projectDir, "file1.txt"), "first file, fixed content\n");
  spawnSync("git", ["add", "."], { cwd: projectDir });
  spawnSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "-m", "fixed file1"], { cwd: projectDir });

  await withClient(
    { AGENC_GOAL_DB_PATH: dbPath, CLAUDE_PROJECT_DIR: projectDir, AGENC_GOAL_MOCK: "1", AGENC_GOAL_MOCK_PLANNER: plannerFixture, AGENC_GOAL_MOCK_REVIEWER: "APPROVED" },
    async (c) => {
      const r = await c.callTool({ name: "subgoal_complete", arguments: {} });
      check("subgoal_complete succeeds on APPROVED", !r.isError, r.content[0].text.slice(0, 100));
      check("response mentions APPROVED + merged", /APPROVED.*merged/s.test(r.content[0].text));
    },
  );

  const currentBranchAfterMerge = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectDir, encoding: "utf8" }).stdout.trim();
  check("git returned to main after merge", currentBranchAfterMerge === "main");

  await withClient(
    { AGENC_GOAL_DB_PATH: dbPath, CLAUDE_PROJECT_DIR: projectDir, AGENC_GOAL_MOCK: "1", AGENC_GOAL_MOCK_PLANNER: plannerFixture },
    async (c) => {
      const r = await c.callTool({ name: "subgoal_start", arguments: {} });
      check("sg-2 starts (next eligible)", !r.isError && /sg-2/.test(r.content[0].text));
    },
  );

  await writeFile(path.join(projectDir, "file2.txt"), "second file content\n");
  spawnSync("git", ["add", "."], { cwd: projectDir });
  spawnSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "-m", "wrote file2"], { cwd: projectDir });

  await withClient(
    { AGENC_GOAL_DB_PATH: dbPath, CLAUDE_PROJECT_DIR: projectDir, AGENC_GOAL_MOCK: "1", AGENC_GOAL_MOCK_PLANNER: plannerFixture, AGENC_GOAL_MOCK_REVIEWER: "APPROVED" },
    async (c) => {
      const r = await c.callTool({ name: "subgoal_complete", arguments: {} });
      check("sg-2 APPROVED + merged", !r.isError);
    },
  );

  await withClient(
    { AGENC_GOAL_DB_PATH: dbPath, CLAUDE_PROJECT_DIR: projectDir },
    async (c) => {
      const list = await c.callTool({ name: "subgoal_list" });
      check("both subgoals complete in final list", /\[x\] sg-1.*\[x\] sg-2/s.test(list.content[0].text));

      const r = await c.callTool({ name: "goal_update", arguments: { status: "complete" } });
      check("goal_update succeeds when all subgoals complete", !r.isError, r.content[0].text);
    },
  );

  const log = spawnSync("git", ["log", "--first-parent", "--oneline", "main"], { cwd: projectDir, encoding: "utf8" }).stdout;
  const mergeCount = (log.match(/Merge subgoal/g) || []).length;
  check("main has exactly 2 subgoal merge commits", mergeCount === 2, `mergeCount=${mergeCount}`);

  await withClient(
    { AGENC_GOAL_DB_PATH: dbPath, CLAUDE_PROJECT_DIR: projectDir },
    async (c) => {
      const r = await c.callTool({ name: "goal_get" });
      const goal = JSON.parse(r.content[0].text);
      check("final goal status is complete", goal.status === "complete");
    },
  );

  await withClient(
    { AGENC_GOAL_DB_PATH: dbPath, CLAUDE_PROJECT_DIR: projectDir, AGENC_GOAL_MOCK: "1", AGENC_GOAL_MOCK_PLANNER: plannerFixture },
    async (c) => {
      const r1 = await c.callTool({ name: "goal_create", arguments: { objective: "Goal to abandon" } });
      check("can create goal after previous one was completed", !r1.isError);
      const r2 = await c.callTool({ name: "goal_clear", arguments: {} });
      check("goal_clear succeeds", !r2.isError);
      check("goal_clear message mentions cleared", /cleared/.test(r2.content[0].text));
      const r3 = await c.callTool({ name: "goal_get" });
      check("goal_get reports no goal after clear", /No goal exists/.test(r3.content[0].text));
    },
  );

  await withClient(
    { AGENC_GOAL_DB_PATH: dbPath, CLAUDE_PROJECT_DIR: projectDir, AGENC_GOAL_MOCK: "1", AGENC_GOAL_MOCK_PLANNER: plannerFixture, AGENC_GOAL_MOCK_REVIEWER: "NEEDS_REVISION", AGENC_GOAL_MAX_ITERATIONS: "2" },
    async (c) => {
      await c.callTool({ name: "goal_create", arguments: { objective: "Iter cap test" } });
      await c.callTool({ name: "subgoal_start", arguments: {} });
      const fs = await import("node:fs/promises");
      await fs.writeFile(path.join(projectDir, "iter.txt"), "x");
      spawnSync("git", ["add", "."], { cwd: projectDir });
      spawnSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "-m", "iter1"], { cwd: projectDir });

      const r1 = await c.callTool({ name: "subgoal_complete", arguments: {} });
      check("first iter NEEDS_REVISION", r1.isError && /NEEDS_REVISION/.test(r1.content[0].text));

      const r2 = await c.callTool({ name: "subgoal_complete", arguments: {} });
      check("second iter NEEDS_REVISION", r2.isError && /NEEDS_REVISION/.test(r2.content[0].text));

      const r3 = await c.callTool({ name: "subgoal_complete", arguments: {} });
      check("third iter exceeds cap, auto-blocked", r3.isError && /Iteration cap.*exceeded/i.test(r3.content[0].text));

      await c.callTool({ name: "goal_clear" });
    },
  );

  await rm(tmpRoot, { recursive: true, force: true });

  console.log(`\n=== ${failed ? "FAILED" : "PASSED"} ===\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(1);
});
