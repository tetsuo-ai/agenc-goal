// MCP server, Stop hook, and SessionStart hook all write the same JSON
// store concurrently — withDbLock serializes them via O_EXCL on a sibling
// .lock file.

import { open, readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import process from "node:process";

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_MS = 100;

export function defaultDbPath() {
  return (
    process.env.AGENC_GOAL_DB_PATH ||
    path.join(os.homedir(), ".agenc", "agenc-goals.json")
  );
}

export function lockPathFor(dbPath) {
  return `${dbPath}.lock`;
}

export async function withDbLock(fn, { dbPath = defaultDbPath(), timeoutMs = DEFAULT_LOCK_TIMEOUT_MS } = {}) {
  const lockPath = lockPathFor(dbPath);
  const start = Date.now();
  let handle;
  for (;;) {
    try {
      await mkdir(path.dirname(lockPath), { recursive: true });
      handle = await open(lockPath, "wx");
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
      );
      break;
    } catch (err) {
      if (err && err.code === "EEXIST") {
        if (Date.now() - start > timeoutMs) {
          throw new Error(
            `Timed out (${timeoutMs}ms) waiting for DB lock at ${lockPath}. ` +
              `If you're sure no other process holds it, remove the lock file and retry.`,
          );
        }
        await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
        continue;
      }
      throw err;
    }
  }
  try {
    return await fn();
  } finally {
    try { await handle.close(); } catch {}
    try { await unlink(lockPath); } catch {}
  }
}

// Reads are lock-free — saveDb writes via rename, not in-place mutation,
// so a concurrent reader either sees the old file or the new one.
export async function loadDb({ dbPath = defaultDbPath() } = {}) {
  try {
    return JSON.parse(await readFile(dbPath, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") return { goals: {} };
    throw err;
  }
}

// Caller must hold the lock.
export async function saveDb(db, { dbPath = defaultDbPath() } = {}) {
  await mkdir(path.dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.tmp`;
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath);
}

export async function mutateDb(mutator, opts = {}) {
  return withDbLock(async () => {
    const db = await loadDb(opts);
    const result = await mutator(db);
    await saveDb(db, opts);
    return result;
  }, opts);
}
