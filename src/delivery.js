import { runProcess } from "./process.js";

function output(result) {
  return (result.stderr || result.stdout || result.processError || "command failed").trim();
}

async function command(executable, args, { cwd, signal, timeoutSeconds = 120, env } = {}) {
  return runProcess(executable, args, {
    cwd,
    signal,
    timeoutSeconds,
    env,
    maxCaptureChars: 12000,
  });
}

async function git(args, options) {
  return command("git", args, options);
}

function failed(step, result, details = {}) {
  return {
    status: result.cancelled ? "cancelled" : "failed",
    step,
    error: `${step} failed: ${output(result)}`,
    ...details,
  };
}

function branchSlug(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9._/-]+/g, "-")
      .replace(/\.{2,}/g, ".")
      .replace(/\/{2,}/g, "/")
      .replace(/^[-./]+|[-./]+$/g, "") || "task"
  );
}

async function createCommit({ cwd, message, baseCommit, signal }) {
  const status = await git(["status", "--porcelain=v1", "--untracked-files=all"], { cwd, signal });
  if (status.exitCode !== 0) return failed("Inspecting Git changes", status);

  if (status.stdout.trim()) {
    const add = await git(["add", "--all"], { cwd, signal });
    if (add.exitCode !== 0) return failed("Staging changes", add);
    const commit = await git(["commit", "-m", message], { cwd, signal });
    if (commit.exitCode !== 0) return failed("Creating commit", commit);
  }

  const head = await git(["rev-parse", "HEAD"], { cwd, signal });
  if (head.exitCode !== 0) return failed("Resolving commit", head);
  const commitHash = head.stdout.trim();
  if (commitHash === baseCommit) {
    return {
      status: "failed",
      step: "Creating commit",
      error: "Creating commit failed: the verified run produced no changes",
    };
  }
  return { status: "success", commitHash };
}

export async function deliverRun({ state, task, signal }) {
  const config = task.delivery;
  if (!config || config.mode === "none") return { mode: "none", status: "skipped" };

  const common = {
    mode: config.mode,
    startedAt: new Date().toISOString(),
  };
  const committed = await createCommit({
    cwd: state.worktreePath,
    message: config.commitMessage,
    baseCommit: state.baseCommit,
    signal,
  });
  if (committed.status !== "success") return { ...common, ...committed };
  if (config.mode === "commit") {
    return { ...common, ...committed, completedAt: new Date().toISOString() };
  }

  const branch = `${branchSlug(config.branchPrefix)}/${branchSlug(task.name)}-${branchSlug(state.id)}`;
  const validBranch = await git(["check-ref-format", "--branch", branch], { cwd: state.worktreePath, signal });
  if (validBranch.exitCode !== 0) return { ...common, ...committed, ...failed("Validating branch name", validBranch) };

  const createBranch = await git(["switch", "-c", branch], { cwd: state.worktreePath, signal });
  if (createBranch.exitCode !== 0) {
    return { ...common, ...committed, branch, ...failed("Creating delivery branch", createBranch) };
  }

  const push = await git(["push", config.remote, `HEAD:refs/heads/${branch}`], {
    cwd: state.worktreePath,
    signal,
    timeoutSeconds: 300,
  });
  if (push.exitCode !== 0) return { ...common, ...committed, branch, ...failed("Pushing delivery branch", push) };

  const body = [
    "Implemented and verified by loops.",
    "",
    `Run: ${state.id}`,
    `Task: ${task.name}`,
    `Verification: ${task.verification.map((check) => check.name).join(", ")}`,
  ].join("\n");
  const gh = await command(
    process.env.LOOPS_GH_PATH || "gh",
    ["pr", "create", "--base", config.base, "--head", branch, "--title", config.title, "--body", body],
    {
      cwd: state.worktreePath,
      signal,
      timeoutSeconds: 300,
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    },
  );
  if (gh.exitCode !== 0)
    return { ...common, ...committed, branch, pushed: true, ...failed("Creating pull request", gh) };

  const prUrl = gh.stdout.match(/https?:\/\/\S+/)?.[0];
  return {
    ...common,
    ...committed,
    branch,
    pushed: true,
    prUrl,
    completedAt: new Date().toISOString(),
  };
}
