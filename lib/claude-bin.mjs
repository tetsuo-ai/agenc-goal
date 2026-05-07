// Resolve the path to the `claude` CLI binary. The MCP server's spawn
// environment may not include the directory where `claude` lives.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";

let cached;

function tryShellResolve(shellCmd) {
  try {
    const r = execSync(shellCmd, { encoding: "utf8", timeout: 5000 }).trim();
    if (r && existsSync(r)) return r;
  } catch {}
  return null;
}

export function findClaudeBin() {
  if (cached) return cached;

  if (process.env.AGENC_GOAL_CLAUDE_BIN && existsSync(process.env.AGENC_GOAL_CLAUDE_BIN)) {
    cached = process.env.AGENC_GOAL_CLAUDE_BIN;
    process.stderr.write(`[agenc-goal] claude bin: ${cached} (env override)\n`);
    return cached;
  }

  const home = os.homedir();
  const userShell = process.env.SHELL || "/bin/bash";
  const candidates = [
    path.join(home, ".local", "bin", "claude"),
    path.join(home, ".claude", "local", "bin", "claude"),
    path.join(home, ".npm-global", "bin", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    "/usr/bin/claude",
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      cached = c;
      process.stderr.write(`[agenc-goal] claude bin: ${cached} (filesystem)\n`);
      return cached;
    }
  }

  const shellResolves = [
    "command -v claude 2>/dev/null",
    `${userShell} -lc 'command -v claude' 2>/dev/null`,
    "bash -lc 'command -v claude' 2>/dev/null",
    "zsh -lc 'command -v claude' 2>/dev/null",
  ];
  for (const cmd of shellResolves) {
    const r = tryShellResolve(cmd);
    if (r) {
      cached = r;
      process.stderr.write(`[agenc-goal] claude bin: ${cached} (shell: ${cmd})\n`);
      return cached;
    }
  }

  cached = "claude";
  process.stderr.write(`[agenc-goal] claude bin: not found, falling back to PATH lookup\n`);
  return cached;
}
