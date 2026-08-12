import { readFile } from "node:fs/promises";
import path from "node:path";
import { runAgent } from "./agent.js";
import { deliverRun } from "./delivery.js";
import { ConfigError, PreparationError } from "./errors.js";
import { buildFeedback, buildPrompt, evaluateStop, verificationFingerprintSummary } from "./evidence.js";
import {
  createWorktree,
  gitStatus,
  pathExists,
  repositoryFingerprint,
  resolveRepoRoot,
  verifyGitReference,
} from "./git.js";
import {
  acquireRunLock,
  appendEvent,
  ensureRunNotActive,
  initializeRun,
  loadState,
  saveFeedback,
  saveFinalReport,
  saveState,
} from "./storage.js";
import { loadTask, validateTask } from "./task.js";
import { createRunId, now, TERMINAL_STATUSES, truncate } from "./util.js";
import { runVerification } from "./verifier.js";

function summarizeAgent(agent, maximum) {
  return {
    ...agent,
    stdout: truncate(agent.stdout, maximum),
    stderr: truncate(agent.stderr, maximum),
  };
}

function summarizeReviewHistory(history) {
  return history.flatMap((record) =>
    (record.verification?.checks ?? [])
      .filter((check) => check.type === "agent")
      .map((check) => ({
        iteration: record.iteration,
        name: check.name,
        passed: check.passed,
        verdict: check.verdict
          ? {
              passed: check.verdict.passed,
              summary: check.verdict.summary,
              evidence: check.verdict.evidence ?? [],
              blockingFindings: check.verdict.blockingFindings ?? [],
              advisories: check.verdict.advisories ?? [],
            }
          : null,
      })),
  );
}

async function completeRun(state, paths, status) {
  state.status = status;
  state.completedAt = now();
  const successMessage = state.delivery?.merged
    ? "All verification passed and pull request is merged"
    : state.delivery?.prUrl
      ? "All verification passed and pull request is merge-ready"
      : state.delivery?.commitHash
        ? "All verification passed and commit created"
        : "All verification gates passed";
  state.activity = {
    ...state.activity,
    phase: status,
    message: status === "success" ? successMessage : (state.error ?? `Run stopped: ${status}`),
    iteration: state.iteration,
    startedAt: state.completedAt,
    checks: state.activity?.checks ?? [],
  };
  await saveState(paths, state);
  await appendEvent(paths, status === "success" ? "run.completed" : "run.failed", {
    status,
    iteration: state.iteration,
    error: state.error,
  });
  await saveFinalReport(paths, state);
  return state;
}

async function deliverSuccessfulRun(state, paths, task, signal, onProgress) {
  if (task.delivery.mode === "none") {
    state.delivery = { mode: "none", status: "skipped" };
    return completeRun(state, paths, "success");
  }

  state.status = "delivering";
  state.activity = {
    ...state.activity,
    phase: "delivering",
    message: task.delivery.mode === "pr" ? "Creating and monitoring pull request" : "Creating verified commit",
    startedAt: now(),
  };
  await saveState(paths, state);
  await appendEvent(paths, "delivery.started", { mode: task.delivery.mode });
  onProgress({ type: "activity.updated", runId: state.id, task: state.task, activity: state.activity });

  let deliveryWrites = Promise.resolve();
  const persistDeliveryProgress = (delivery) => {
    deliveryWrites = deliveryWrites.then(async () => {
      state.delivery = structuredClone(delivery);
      state.activity = {
        ...state.activity,
        message: delivery.message,
        deliveryStep: delivery.step,
        deliveryIteration: delivery.iteration,
        prUrl: delivery.prUrl,
        heartbeatAt: now(),
      };
      await saveState(paths, state);
      await appendEvent(paths, "delivery.progress", {
        status: delivery.status,
        step: delivery.step,
        iteration: delivery.iteration,
        prUrl: delivery.prUrl,
      });
      onProgress({ type: "activity.updated", runId: state.id, task: state.task, activity: state.activity });
    });
    return deliveryWrites;
  };
  const heartbeat = setInterval(() => {
    deliveryWrites = deliveryWrites.then(async () => {
      state.activity.heartbeatAt = now();
      await saveState(paths, state);
    });
  }, 5000);
  heartbeat.unref();
  try {
    state.delivery = await deliverRun({ state, task, signal, onProgress: persistDeliveryProgress });
  } finally {
    clearInterval(heartbeat);
    await deliveryWrites;
  }
  await appendEvent(paths, state.delivery.status === "success" ? "delivery.completed" : "delivery.failed", {
    ...state.delivery,
  });
  await saveState(paths, state);
  if (state.delivery.status === "cancelled" || signal?.aborted) {
    state.error = "Run cancelled during delivery";
    return completeRun(state, paths, "cancelled");
  }
  if (state.delivery.status !== "success") {
    state.error = state.delivery.error ?? "Automatic delivery failed";
    return completeRun(state, paths, "delivery_failed");
  }
  return completeRun(state, paths, "success");
}

export async function planRun(taskPath, { noWorktree = false, cwd = process.cwd() } = {}) {
  const loaded = await loadTask(taskPath);
  let repoRoot;
  try {
    repoRoot = await resolveRepoRoot(path.dirname(loaded.path));
  } catch (error) {
    if (path.resolve(cwd) === path.dirname(loaded.path)) throw error;
    repoRoot = await resolveRepoRoot(cwd);
  }
  const task = structuredClone(loaded.task);
  if (noWorktree) task.worktree.enabled = false;
  if (!task.worktree.enabled && task.delivery.mode !== "none") {
    throw new ConfigError("Automatic commit or pull-request delivery requires an isolated worktree");
  }
  const baseCommit = task.worktree.enabled ? await verifyGitReference(repoRoot, task.worktree.base) : null;
  return {
    taskPath: loaded.path,
    repoRoot,
    worktree: task.worktree.enabled
      ? { enabled: true, base: task.worktree.base, path: path.join(repoRoot, ".loop", "worktrees", "<run-id>") }
      : { enabled: false, path: repoRoot },
    verification: task.verification,
    limits: task.limits,
    sessionStrategy: task.sessionStrategy,
    agent: task.agent,
    delivery: task.delivery,
    baseCommit,
  };
}

export async function createRun(taskPath, { noWorktree = false, cwd = process.cwd() } = {}) {
  const loaded = await loadTask(taskPath);
  let repoRoot;
  try {
    repoRoot = await resolveRepoRoot(path.dirname(loaded.path));
  } catch (error) {
    if (path.resolve(cwd) === path.dirname(loaded.path)) throw error;
    repoRoot = await resolveRepoRoot(cwd);
  }
  const task = structuredClone(loaded.task);
  if (noWorktree) task.worktree.enabled = false;
  if (!task.worktree.enabled && task.delivery.mode !== "none") {
    throw new ConfigError("Automatic commit or pull-request delivery requires an isolated worktree");
  }
  const baseCommit = task.worktree.enabled ? await verifyGitReference(repoRoot, task.worktree.base) : null;
  const runId = createRunId();
  const paths = await initializeRun(repoRoot, runId);
  const state = {
    id: runId,
    task: task.name,
    taskPath: loaded.path,
    taskConfig: task,
    repoRoot,
    worktreePath: task.worktree.enabled ? paths.worktreePath : repoRoot,
    worktreeEnabled: task.worktree.enabled,
    status: "preparing",
    iteration: 0,
    noProgress: 0,
    sessionId: null,
    previousFingerprint: null,
    baseCommit,
    activity: {
      phase: "preparing",
      message: "Preparing isolated workspace",
      iteration: 0,
      startedAt: now(),
      checks: [],
    },
    history: [],
    startedAt: now(),
    updatedAt: now(),
  };
  await saveState(paths, state);
  await appendEvent(paths, "run.started", { runId, task: task.name });

  try {
    if (task.worktree.enabled) {
      await createWorktree({ repoRoot, worktreePath: paths.worktreePath, base: task.worktree.base });
    }
    state.status = "running";
    await saveState(paths, state);
    return { state, paths, task, feedback: null };
  } catch (error) {
    state.error = error.message;
    await completeRun(state, paths, "failed_to_start");
    throw error;
  }
}

async function readFeedback(paths) {
  try {
    return await readFile(paths.feedbackPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function resumeRun(repoRoot, runId, { taskPath } = {}) {
  const loaded = await loadState(repoRoot, runId);
  const { state, paths } = loaded;
  if (state.status === "success") return { state, paths, alreadyComplete: true };
  if (TERMINAL_STATUSES.has(state.status)) {
    throw new ConfigError(`Run ${runId} is terminal with status ${state.status} and cannot be resumed`);
  }
  if (!(await pathExists(state.worktreePath))) {
    throw new PreparationError(`Run worktree no longer exists: ${state.worktreePath}`);
  }
  await ensureRunNotActive(paths);

  let task;
  const sourcePath = taskPath ? path.resolve(taskPath) : state.taskPath;
  try {
    ({ task } = await loadTask(sourcePath));
  } catch (error) {
    if (taskPath || !state.taskConfig) throw error;
    task = validateTask(state.taskConfig);
  }
  if (!state.worktreeEnabled) task.worktree.enabled = false;
  if (!task.worktree.enabled && task.delivery.mode !== "none") {
    throw new ConfigError("Automatic commit or pull-request delivery requires an isolated worktree");
  }
  state.baseCommit ??= task.worktree.enabled ? await verifyGitReference(repoRoot, task.worktree.base) : null;
  state.sessionId ??= state.threadId ?? null;
  state.taskPath = sourcePath;
  state.taskConfig = task;
  if (state.currentIteration) {
    state.history.push({
      ...state.currentIteration,
      passed: false,
      interrupted: true,
      completedAt: now(),
    });
    delete state.currentIteration;
  }
  state.status = "running";
  await saveState(paths, state);
  return { state, paths, task, feedback: await readFeedback(paths) };
}

async function executeRunUnlocked(context, { onProgress = () => {}, signal } = {}) {
  const { state, paths, task } = context;
  if (context.alreadyComplete) return state;
  let feedback = context.feedback;

  while (state.iteration < task.limits.maxIterations) {
    const iteration = state.iteration + 1;
    state.iteration = iteration;
    state.status = "running";
    const prompt = buildPrompt({ task, iteration, feedback });
    state.currentIteration = { iteration, prompt, startedAt: now() };
    state.activity = {
      phase: "implementing",
      message: `${task.agent.provider} is working`,
      provider: task.agent.provider,
      iteration,
      maxIterations: task.limits.maxIterations,
      startedAt: now(),
      checks: [],
    };
    await saveState(paths, state);
    await appendEvent(paths, "iteration.started", { iteration });
    onProgress({ type: "iteration.started", iteration, runId: state.id });
    onProgress({ type: "activity.updated", runId: state.id, task: state.task, activity: state.activity });

    const sessionId = task.sessionStrategy === "resume" ? state.sessionId : undefined;
    let activityWrites = Promise.resolve();
    const persistActivity = () => {
      activityWrites = activityWrites.then(() => saveState(paths, state));
    };
    const heartbeat = setInterval(() => {
      state.activity.heartbeatAt = now();
      persistActivity();
    }, 5000);
    heartbeat.unref();

    const agent = await runAgent({
      provider: task.agent.provider,
      cwd: state.worktreePath,
      prompt,
      sandbox: task.agent.sandbox,
      model: task.agent.model,
      sessionId,
      extraArgs: task.agent.extraArgs,
      timeoutSeconds: task.limits.timeoutSeconds,
      signal,
      onActivity: (diagnostic) => {
        state.activity.lastProviderActivityAt = now();
        state.activity.providerDiagnostic = diagnostic;
        state.activity.message = diagnostic.message;
        persistActivity();
        onProgress({ type: "activity.updated", runId: state.id, task: state.task, activity: state.activity });
      },
    });
    clearInterval(heartbeat);
    await activityWrites;
    if (agent.sessionId) {
      state.sessionId = agent.sessionId;
      if (task.agent.provider === "codex") state.threadId = agent.sessionId;
    }
    state.currentIteration.agent = summarizeAgent(agent, task.limits.maxOutputChars);
    await appendEvent(paths, "agent.completed", {
      iteration,
      provider: task.agent.provider,
      exitCode: agent.exitCode,
      timedOut: agent.timedOut,
      signal: agent.signal,
      processError: agent.processError,
      cancelled: agent.cancelled,
      providerError: agent.providerError,
      sessionId: agent.sessionId,
    });
    await saveState(paths, state);

    if (agent.cancelled || signal?.aborted) {
      state.error = "Run cancelled by user";
      state.history.push({ ...state.currentIteration, passed: false, cancelled: true, completedAt: now() });
      delete state.currentIteration;
      return completeRun(state, paths, "cancelled");
    }
    if (agent.providerError) {
      state.error = agent.providerError;
      state.history.push({
        ...state.currentIteration,
        passed: false,
        providerError: agent.providerError,
        completedAt: now(),
      });
      delete state.currentIteration;
      return completeRun(state, paths, "provider_error");
    }

    state.status = "verifying";
    state.activity = {
      phase: "verifying",
      message: "Running verification gates",
      provider: task.agent.provider,
      iteration,
      maxIterations: task.limits.maxIterations,
      startedAt: now(),
      checks: task.verification.map((check) => ({
        name: check.name,
        type: check.type,
        provider: check.provider,
        status: "waiting",
      })),
    };
    await saveState(paths, state);
    onProgress({ type: "activity.updated", runId: state.id, task: state.task, activity: state.activity });
    const reviewChangeSummary = await gitStatus(state.worktreePath);
    let verificationActivityWrites = Promise.resolve();
    const verification = await runVerification({
      cwd: state.worktreePath,
      checks: task.verification,
      goal: task.goal,
      baseCommit: state.baseCommit,
      changeSummary: reviewChangeSummary,
      reviewHistory: summarizeReviewHistory(state.history),
      timeoutSeconds: task.limits.timeoutSeconds,
      maxOutputChars: task.limits.maxOutputChars,
      signal,
      onCheckStarted: async (check, index) => {
        state.activity.checks[index] = {
          ...state.activity.checks[index],
          status: "running",
          startedAt: now(),
        };
        state.activity.message = `Verifying: ${check.name}`;
        await saveState(paths, state);
        onProgress({ type: "activity.updated", runId: state.id, task: state.task, activity: state.activity });
      },
      onCheckCompleted: async (check, index) => {
        state.activity.checks[index] = {
          ...state.activity.checks[index],
          status: check.passed ? "passed" : "failed",
          passed: check.passed,
          durationMs: check.durationMs,
        };
        state.activity.message = `${check.name}: ${check.passed ? "passed" : "failed"}`;
        await saveState(paths, state);
        onProgress({ type: "activity.updated", runId: state.id, task: state.task, activity: state.activity });
      },
      onCheckActivity: (check, index, diagnostic) => {
        state.activity.checks[index] = {
          ...state.activity.checks[index],
          diagnostic,
        };
        state.activity.message = `${check.name}: ${diagnostic.message}`;
        verificationActivityWrites = verificationActivityWrites.then(() => saveState(paths, state));
        onProgress({ type: "activity.updated", runId: state.id, task: state.task, activity: state.activity });
      },
    });
    await verificationActivityWrites;
    state.currentIteration.verification = verification;
    await appendEvent(paths, "verification.completed", {
      iteration,
      passed: verification.passed,
      checks: verification.checks.map(({ name, type, provider, passed, exitCode, timedOut, verdict }) => ({
        name,
        type,
        provider,
        passed,
        exitCode,
        timedOut,
        verdict: verdict
          ? {
              passed: verdict.passed,
              summary: verdict.summary,
              blockingFindings: verdict.blockingFindings,
              advisories: verdict.advisories,
            }
          : undefined,
      })),
    });
    await saveState(paths, state);

    if (verification.cancelled || signal?.aborted) {
      state.error = "Run cancelled by user";
      state.history.push({ ...state.currentIteration, passed: false, cancelled: true, completedAt: now() });
      delete state.currentIteration;
      return completeRun(state, paths, "cancelled");
    }
    if (verification.providerError) {
      state.error = `Verification gate ${verification.providerError.name}: ${verification.providerError.providerError}`;
      state.history.push({
        ...state.currentIteration,
        passed: false,
        providerError: state.error,
        completedAt: now(),
      });
      delete state.currentIteration;
      return completeRun(state, paths, "provider_error");
    }

    const agentPassed = agent.exitCode === 0 && !agent.timedOut && !agent.processError;
    const passed = agentPassed && verification.passed;
    const statusText = await gitStatus(state.worktreePath);
    const fingerprint = await repositoryFingerprint(state.worktreePath, verificationFingerprintSummary(verification));
    state.activity.phase = "persisting";
    state.activity.message = "Saving iteration evidence";
    state.activity.startedAt = now();
    await saveState(paths, state);
    onProgress({ type: "activity.updated", runId: state.id, task: state.task, activity: state.activity });
    state.noProgress = fingerprint === state.previousFingerprint ? state.noProgress + 1 : 0;
    state.previousFingerprint = fingerprint;

    const record = {
      ...state.currentIteration,
      gitStatus: statusText,
      fingerprint,
      passed,
      completedAt: now(),
    };
    state.history.push(record);
    delete state.currentIteration;

    if (!passed) {
      feedback = buildFeedback({
        iteration,
        agent,
        verification,
        gitStatus: statusText,
        maxOutputChars: task.limits.maxOutputChars,
      });
      await saveFeedback(paths, feedback);
    }

    const terminal = evaluateStop({
      passed,
      timedOut: agent.timedOut,
      noProgress: state.noProgress,
      iteration,
      limits: task.limits,
    });
    state.status = terminal ?? "running";
    await saveState(paths, state);
    await appendEvent(paths, "iteration.completed", { iteration, passed, noProgress: state.noProgress });
    onProgress({ type: "iteration.completed", iteration, passed, noProgress: state.noProgress });
    if (terminal === "success") return deliverSuccessfulRun(state, paths, task, signal, onProgress);
    if (terminal) return completeRun(state, paths, terminal);
    state.activity = {
      ...state.activity,
      phase: "retrying",
      message: "Preparing the next iteration",
      startedAt: now(),
    };
    await saveState(paths, state);
    onProgress({ type: "activity.updated", runId: state.id, task: state.task, activity: state.activity });
  }

  return completeRun(state, paths, "max_iterations");
}

export async function executeRun(context, options = {}) {
  const release = await acquireRunLock(context.paths);
  try {
    return await executeRunUnlocked(context, options);
  } finally {
    await release();
  }
}
