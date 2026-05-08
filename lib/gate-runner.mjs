// Gates run sequentially fail-fast. Per-gate timeouts are opt-in via
// .agenc/gates.json — by default a gate runs to completion.

import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const GATE_DEFAULT_HANG_TIMEOUT_MS = parseInt(process.env.AGENC_GOAL_GATE_TIMEOUT_MS) || 600_000;
const OUTPUT_TAIL_BYTES = parseInt(process.env.AGENC_GOAL_OUTPUT_TAIL_BYTES) || 4096;

function tail(chunks, totalLen) {
  if (totalLen === 0) return "";
  const buf = Buffer.concat(chunks, totalLen);
  if (buf.length <= OUTPUT_TAIL_BYTES) return buf.toString("utf8");
  return `... [truncated ${buf.length - OUTPUT_TAIL_BYTES} earlier bytes]\n` +
    buf.subarray(buf.length - OUTPUT_TAIL_BYTES).toString("utf8");
}

export async function autoDetectGates(cwd) {
  const gates = [];

  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
    const scripts = pkg.scripts || {};
    if (scripts.test) gates.push({ name: "tests", cmd: "npm test" });
    if (scripts.lint) gates.push({ name: "lint", cmd: "npm run lint" });
    if (scripts.typecheck) gates.push({ name: "typecheck", cmd: "npm run typecheck" });
  } catch {}

  if (gates.length === 0) {
    if (await fileExists(path.join(cwd, "pyproject.toml")) || await fileExists(path.join(cwd, "pytest.ini"))) {
      gates.push({ name: "pytest", cmd: "pytest" });
    }
  }

  if (gates.length === 0 && await fileExists(path.join(cwd, "Cargo.toml"))) {
    gates.push({ name: "cargo-test", cmd: "cargo test" });
  }

  if (gates.length === 0 && await fileExists(path.join(cwd, "go.mod"))) {
    gates.push({ name: "go-test", cmd: "go test ./..." });
  }

  if (gates.length === 0) {
    try {
      const mk = await readFile(path.join(cwd, "Makefile"), "utf8");
      if (/^test:/m.test(mk)) gates.push({ name: "make-test", cmd: "make test" });
    } catch {}
  }

  return gates;
}

export async function loadExplicitGates(cwd) {
  try {
    const raw = await readFile(path.join(cwd, ".agenc", "gates.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.gates)) {
      throw new Error(".agenc/gates.json must have a `gates` array");
    }
    return parsed.gates.map((g) => ({
      name: g.name,
      cmd: g.cmd,
      timeout_ms: g.timeout_ms ?? parsed.default_timeout_ms,
    }));
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

export async function resolveGates(cwd) {
  const explicit = await loadExplicitGates(cwd);
  if (explicit !== null) return explicit;
  return await autoDetectGates(cwd);
}

function runOne(gate, cwd) {
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn(gate.cmd, {
      shell: true,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let timedOut = false;
    let timer;
    const timeoutMs = gate.timeout_ms ?? GATE_DEFAULT_HANG_TIMEOUT_MS;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      }, timeoutMs);
    }
    child.stdout.on("data", (b) => { stdoutChunks.push(b); stdoutLen += b.length; });
    child.stderr.on("data", (b) => { stderrChunks.push(b); stderrLen += b.length; });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        name: gate.name,
        cmd: gate.cmd,
        exit: code ?? -1,
        signal: signal || null,
        timed_out: timedOut,
        ms: Date.now() - start,
        stdout: tail(stdoutChunks, stdoutLen),
        stderr: tail(stderrChunks, stderrLen),
      });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        name: gate.name,
        cmd: gate.cmd,
        exit: -1,
        signal: null,
        timed_out: false,
        ms: Date.now() - start,
        stdout: "",
        stderr: `failed to spawn: ${err.message}`,
      });
    });
  });
}

export async function runGates(gates, cwd) {
  const results = [];
  for (const gate of gates) {
    const r = await runOne(gate, cwd);
    results.push(r);
    if (r.exit !== 0 || r.timed_out || r.signal) {
      return { passed: false, results };
    }
  }
  return { passed: results.length > 0, results };
}

async function fileExists(p) {
  try { await stat(p); return true; } catch { return false; }
}
