import { test } from "node:test";
import assert from "node:assert/strict";
import { autoDetectGates, loadExplicitGates, resolveGates, runGates } from "../../lib/gate-runner.mjs";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

async function withTmpDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agenc-gates-"));
  try { return await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test("autoDetectGates finds npm scripts", async () => {
  await withTmpDir(async (dir) => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({
      scripts: { test: "x", lint: "y", typecheck: "z" },
    }));
    const gates = await autoDetectGates(dir);
    assert.equal(gates.length, 3);
    assert.equal(gates[0].cmd, "npm test");
    assert.equal(gates[1].cmd, "npm run lint");
    assert.equal(gates[2].cmd, "npm run typecheck");
  });
});

test("autoDetectGates skips npm scripts that don't exist", async () => {
  await withTmpDir(async (dir) => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({
      scripts: { test: "x" },
    }));
    const gates = await autoDetectGates(dir);
    assert.equal(gates.length, 1);
    assert.equal(gates[0].cmd, "npm test");
  });
});

test("autoDetectGates falls through to pytest when no npm", async () => {
  await withTmpDir(async (dir) => {
    await writeFile(path.join(dir, "pyproject.toml"), "[tool.poetry]");
    const gates = await autoDetectGates(dir);
    assert.equal(gates.length, 1);
    assert.equal(gates[0].cmd, "pytest");
  });
});

test("autoDetectGates falls through to cargo test", async () => {
  await withTmpDir(async (dir) => {
    await writeFile(path.join(dir, "Cargo.toml"), "[package]");
    const gates = await autoDetectGates(dir);
    assert.equal(gates[0].cmd, "cargo test");
  });
});

test("autoDetectGates falls through to go test", async () => {
  await withTmpDir(async (dir) => {
    await writeFile(path.join(dir, "go.mod"), "module test");
    const gates = await autoDetectGates(dir);
    assert.equal(gates[0].cmd, "go test ./...");
  });
});

test("autoDetectGates falls through to make test", async () => {
  await withTmpDir(async (dir) => {
    await writeFile(path.join(dir, "Makefile"), "test:\n\techo hi\n");
    const gates = await autoDetectGates(dir);
    assert.equal(gates[0].cmd, "make test");
  });
});

test("autoDetectGates returns empty when no markers", async () => {
  await withTmpDir(async (dir) => {
    const gates = await autoDetectGates(dir);
    assert.deepEqual(gates, []);
  });
});

test("loadExplicitGates returns null when .agenc/gates.json missing", async () => {
  await withTmpDir(async (dir) => {
    assert.equal(await loadExplicitGates(dir), null);
  });
});

test("loadExplicitGates parses gates.json", async () => {
  await withTmpDir(async (dir) => {
    await mkdir(path.join(dir, ".agenc"), { recursive: true });
    await writeFile(path.join(dir, ".agenc", "gates.json"), JSON.stringify({
      gates: [
        { name: "t", cmd: "echo t" },
        { name: "l", cmd: "echo l", timeout_ms: 5000 },
      ],
      default_timeout_ms: 60000,
    }));
    const gates = await loadExplicitGates(dir);
    assert.equal(gates.length, 2);
    assert.equal(gates[0].timeout_ms, 60000);
    assert.equal(gates[1].timeout_ms, 5000);
  });
});

test("resolveGates: explicit overrides auto-detect", async () => {
  await withTmpDir(async (dir) => {
    await writeFile(path.join(dir, "Makefile"), "test:\n\techo hi\n");
    await mkdir(path.join(dir, ".agenc"), { recursive: true });
    await writeFile(path.join(dir, ".agenc", "gates.json"), JSON.stringify({
      gates: [{ name: "custom", cmd: "echo custom" }],
    }));
    const gates = await resolveGates(dir);
    assert.equal(gates.length, 1);
    assert.equal(gates[0].name, "custom");
  });
});

test("runGates: passing gate", async () => {
  const r = await runGates([{ name: "ok", cmd: "echo passing" }], "/tmp");
  assert.equal(r.passed, true);
  assert.equal(r.results[0].exit, 0);
});

test("runGates: failing gate stops at first failure", async () => {
  const r = await runGates([
    { name: "first", cmd: "echo first" },
    { name: "fail", cmd: "false" },
    { name: "third", cmd: "echo never-runs" },
  ], "/tmp");
  assert.equal(r.passed, false);
  assert.equal(r.results.length, 2);
  assert.equal(r.results[1].exit, 1);
});

test("runGates: empty gates list returns passed=false", async () => {
  // No gates configured = nothing to verify, treat as not-passed (gates
  // expected by the contract). The reviewer step still runs in the calling
  // code if the project intentionally has no gates.
  const r = await runGates([], "/tmp");
  assert.equal(r.passed, false);
});
