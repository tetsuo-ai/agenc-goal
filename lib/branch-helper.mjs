// Subgoal branches use --no-ff merges so the boundary stays visible in
// `git log --first-parent`. All operations are no-ops outside a git repo.

import { spawn } from "node:child_process";

const GIT_TIMEOUT_MS = 30_000;

function git(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (b) => stdoutChunks.push(b));
    child.stderr.on("data", (b) => stderrChunks.push(b));
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exit: code ?? -1,
      });
    });
    child.on("error", (err) => {
      resolve({ ok: false, stdout: "", stderr: String(err), exit: -1 });
    });
  });
}

export async function inGitRepo(cwd) {
  const r = await git(["rev-parse", "--is-inside-work-tree"], cwd);
  return r.ok && r.stdout.trim() === "true";
}

export async function currentBranch(cwd) {
  const r = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (!r.ok) return null;
  const name = r.stdout.trim();
  return name === "HEAD" ? null : name;
}

// goalId is a UUID; the leading 8 hex chars keep branch names readable
// without losing meaningful uniqueness.
export function branchNameFor(goalId, subgoalId) {
  const short = String(goalId).replace(/-/g, "").slice(0, 8);
  return `agenc-goal/${short}/${subgoalId}`;
}

export async function startSubgoalBranch(cwd, goalId, subgoalId) {
  if (!(await inGitRepo(cwd))) return { ok: false, reason: "not_git_repo" };

  const parent = await currentBranch(cwd);
  if (!parent) return { ok: false, reason: "detached_head" };

  const branch = branchNameFor(goalId, subgoalId);

  const exists = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd);
  if (exists.ok) {
    const co = await git(["checkout", branch], cwd);
    if (!co.ok) return { ok: false, reason: "git_error", error: co.stderr };
    return { ok: true, branch, parent, reused: true };
  }

  const co = await git(["checkout", "-b", branch], cwd);
  if (!co.ok) return { ok: false, reason: "git_error", error: co.stderr };
  return { ok: true, branch, parent, reused: false };
}

export async function mergeSubgoalBranch(cwd, branch, parent) {
  if (!(await inGitRepo(cwd))) return { ok: false, reason: "not_git_repo" };

  const co = await git(["checkout", parent], cwd);
  if (!co.ok) return { ok: false, reason: "git_error", error: co.stderr };

  const merge = await git(
    ["merge", "--no-ff", "-m", `Merge subgoal ${branch}`, branch],
    cwd,
  );
  if (!merge.ok) {
    await git(["merge", "--abort"], cwd);
    return {
      ok: false,
      reason: "merge_conflict",
      error: merge.stderr || merge.stdout,
    };
  }
  return { ok: true, branch, parent };
}

export async function diffSubgoalBranch(cwd, branch, parent) {
  if (!(await inGitRepo(cwd))) return null;
  const r = await git(["diff", `${parent}...${branch}`], cwd);
  if (!r.ok) return null;
  return r.stdout;
}
