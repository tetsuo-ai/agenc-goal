import { test } from "node:test";
import assert from "node:assert/strict";
import { withDbLock, loadDb, saveDb, mutateDb } from "../../lib/db.mjs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

async function withTmpDb(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agenc-db-"));
  const dbPath = path.join(dir, "goals.json");
  try {
    return await fn(dbPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("loadDb returns empty when file does not exist", async () => {
  await withTmpDb(async (dbPath) => {
    const db = await loadDb({ dbPath });
    assert.deepEqual(db, { goals: {} });
  });
});

test("saveDb + loadDb round-trip", async () => {
  await withTmpDb(async (dbPath) => {
    await withDbLock(async () => {
      await saveDb({ goals: { foo: { objective: "test" } } }, { dbPath });
    }, { dbPath });
    const db = await loadDb({ dbPath });
    assert.deepEqual(db.goals.foo.objective, "test");
  });
});

test("withDbLock serializes concurrent writers", async () => {
  await withTmpDb(async (dbPath) => {
    await mutateDb((db) => { db.counter = 0; }, { dbPath });
    // Without the lock, the setImmediate yield below would let all 5
    // increments read 0 and the final counter would be 1, not 5.
    await Promise.all(Array.from({ length: 5 }, () =>
      mutateDb(async (db) => {
        const before = db.counter;
        await new Promise((r) => setImmediate(r));
        db.counter = before + 1;
      }, { dbPath })
    ));
    const db = await loadDb({ dbPath });
    assert.equal(db.counter, 5);
  });
});

test("withDbLock cleans up lock file on success", async () => {
  await withTmpDb(async (dbPath) => {
    await withDbLock(async () => {}, { dbPath });
    const lockPath = `${dbPath}.lock`;
    await assert.rejects(() => readFile(lockPath, "utf8"), /ENOENT/);
  });
});

test("withDbLock cleans up lock file on error", async () => {
  await withTmpDb(async (dbPath) => {
    await assert.rejects(
      () => withDbLock(async () => { throw new Error("fn failed"); }, { dbPath }),
      /fn failed/,
    );
    const lockPath = `${dbPath}.lock`;
    await assert.rejects(() => readFile(lockPath, "utf8"), /ENOENT/);
  });
});

test("withDbLock times out when lock is held too long", async () => {
  await withTmpDb(async (dbPath) => {
    const holder = withDbLock(
      () => new Promise((r) => setTimeout(r, 500)),
      { dbPath },
    );
    await assert.rejects(
      () => withDbLock(async () => "ok", { dbPath, timeoutMs: 100 }),
      /Timed out/,
    );
    await holder;
  });
});
