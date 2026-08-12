import { randomBytes } from "node:crypto";
import { appendFile, mkdir, open, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "./errors.js";
import { atomicWriteJson, now, TERMINAL_STATUSES } from "./util.js";

const STALE_HEARTBEAT_MS = 15_000;

export function loopPaths(repoRoot, runId) {
  const loopDir = path.join(repoRoot, ".loop");
  const runDir = path.join(loopDir, "runs", runId);
  return {
    loopDir,
    runDir,
    worktreePath: path.join(loopDir, "worktrees", runId),
    statePath: path.join(runDir, "state.json"),
    eventsPath: path.join(runDir, "events.jsonl"),
    feedbackPath: path.join(runDir, "feedback.md"),
    finalReportPath: path.join(runDir, "final-report.json"),
    lockPath: path.join(runDir, "execution.lock"),
  };
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function existingLock(paths) {
  try {
    return JSON.parse(await readFile(paths.lockPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return {};
  }
}

export async function inspectRunExecution(paths, state, { at = Date.now() } = {}) {
  if (TERMINAL_STATUSES.has(state.status)) return { status: "inactive" };

  const lock = await existingLock(paths);
  const heartbeatAt = state.activity?.heartbeatAt ?? state.updatedAt;
  const heartbeatTime = heartbeatAt ? Date.parse(heartbeatAt) : Number.NaN;
  const heartbeatAgeMs = Number.isFinite(heartbeatTime) ? Math.max(0, at - heartbeatTime) : null;
  if (!lock) {
    if (heartbeatAgeMs !== null && heartbeatAgeMs <= STALE_HEARTBEAT_MS) {
      return { status: "starting", heartbeatAt, heartbeatAgeMs };
    }
    return {
      status: "interrupted",
      heartbeatAt,
      heartbeatAgeMs,
      message: "No executor owns this non-terminal run; use loops resume",
    };
  }
  if (!processIsRunning(lock.pid)) {
    return {
      status: "interrupted",
      pid: Number.isInteger(lock.pid) ? lock.pid : undefined,
      heartbeatAt,
      heartbeatAgeMs,
      message: `${Number.isInteger(lock.pid) ? `Executor process ${lock.pid}` : "Executor process"} is no longer running; use loops resume`,
    };
  }
  if (heartbeatAgeMs !== null && heartbeatAgeMs > STALE_HEARTBEAT_MS) {
    return {
      status: "stalled",
      pid: lock.pid,
      heartbeatAt,
      heartbeatAgeMs,
      message: `Executor process ${lock.pid} is running but its heartbeat is stale`,
    };
  }
  return { status: "active", pid: lock.pid, heartbeatAt, heartbeatAgeMs };
}

export async function ensureRunNotActive(paths) {
  const lock = await existingLock(paths);
  if (!lock) return;
  if (processIsRunning(lock.pid)) {
    throw new ConfigError(`Run ${path.basename(paths.runDir)} is already being executed by process ${lock.pid}`);
  }
  await unlink(paths.lockPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export async function acquireRunLock(paths) {
  await ensureRunNotActive(paths);
  const token = randomBytes(12).toString("hex");
  let handle;
  try {
    handle = await open(paths.lockPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, startedAt: now() })}\n`);
  } catch (error) {
    if (error.code === "EEXIST") {
      const lock = await existingLock(paths);
      throw new ConfigError(
        `Run ${path.basename(paths.runDir)} is already being executed${lock?.pid ? ` by process ${lock.pid}` : ""}`,
      );
    }
    throw error;
  } finally {
    await handle?.close();
  }

  return async () => {
    const lock = await existingLock(paths);
    if (lock?.token !== token) return;
    await unlink(paths.lockPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  };
}

export async function initializeLoopDirectory(repoRoot) {
  const paths = loopPaths(repoRoot, "placeholder");
  await mkdir(path.join(paths.loopDir, "runs"), { recursive: true });
  await mkdir(path.join(paths.loopDir, "worktrees"), { recursive: true });
  const ignorePath = path.join(paths.loopDir, ".gitignore");
  try {
    await writeFile(ignorePath, "runs/\nworktrees/\n", { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

export async function initializeRun(repoRoot, runId) {
  await initializeLoopDirectory(repoRoot);
  const paths = loopPaths(repoRoot, runId);
  await mkdir(paths.runDir, { recursive: false });
  return paths;
}

export async function saveState(paths, state) {
  state.updatedAt = now();
  await atomicWriteJson(paths.statePath, state);
}

export async function appendEvent(paths, type, details = {}) {
  const event = { at: now(), type, ...details };
  await appendFile(paths.eventsPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  return event;
}

export async function saveFeedback(paths, feedback) {
  await writeFile(paths.feedbackPath, feedback, { mode: 0o600 });
}

export async function saveFinalReport(paths, state) {
  await atomicWriteJson(paths.finalReportPath, {
    id: state.id,
    task: state.task,
    status: state.status,
    iteration: state.iteration,
    noProgress: state.noProgress,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    repoRoot: state.repoRoot,
    worktreePath: state.worktreePath,
    delivery: state.delivery,
    latest: state.history.at(-1) ?? null,
  });
}

export async function loadState(repoRoot, runId) {
  const paths = loopPaths(repoRoot, runId);
  try {
    const state = JSON.parse(await readFile(paths.statePath, "utf8"));
    return { state, paths };
  } catch (error) {
    throw new ConfigError(`Cannot load run ${runId}: ${error.message}`, { cause: error });
  }
}

export async function listStates(repoRoot) {
  const runsDir = path.join(repoRoot, ".loop", "runs");
  let names;
  try {
    names = await readdir(runsDir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const states = [];
  for (const name of names) {
    try {
      const { state } = await loadState(repoRoot, name);
      states.push(state);
    } catch {
      // An incomplete/corrupt run should not make other runs undiscoverable.
    }
  }
  return states.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
