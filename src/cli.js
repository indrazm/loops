#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { confirm, input, select } from "@inquirer/prompts";
import { createRun, executeRun, planRun, reconcileRun, resumeRun } from "./controller.js";
import { ConfigError, LoopError, PreparationError } from "./errors.js";
import { pathExists, removeWorktree, resolveRepoRoot } from "./git.js";
import { LiveStatus } from "./status.js";
import { initializeLoopDirectory, listStates, loadState, loopPaths } from "./storage.js";
import { loadTask, STARTER_TASK } from "./task.js";
import { json } from "./util.js";
import { createTaskInteractively } from "./wizard.js";

const USAGE = `Loops — bounded, externally verified coding-agent runs

Usage:
  loops <command> [options]
  loops help | --help | -h

Agent workflow (non-interactive):
  1. Write a task JSON file with name, goal, and at least one verification gate.
  2. Validate it:  loops validate tasks/change.task.json
  3. Preview it:   loops run tasks/change.task.json --dry-run
  4. Execute it:   loops run tasks/change.task.json --quiet
  5. Read status:  loops inspect <run-id>

Commands:
  init [task-file] [--interactive | --defaults]
      Create a task without overwriting an existing file. In a TTY, init prompts
      unless --defaults is supplied. Agents should write task JSON directly or
      use --defaults.

  validate <task-file>
      Validate and print the normalized task as JSON.

  run <task-file> [--dry-run] [--no-worktree] [--quiet]
      Run the task. --dry-run validates and plans without creating run state.
      --no-worktree operates in the current checkout and disables isolation.
      --quiet suppresses progress; it does not change execution.

  resume <run-id> [--task <task-file>] [--repo <path>] [--quiet]
      Continue an incomplete, non-terminal run.

  reconcile <run-id> [--pr <url>] [--repo <path>]
      Recover interrupted PR delivery from persisted verification, the exact
      pushed commit, and current GitHub checks. Use --pr for a follow-up PR.

  watch <run-id> [--repo <path>] [--quiet]
      Monitor a run started by another process.

  list [--repo <path>]
      List persisted runs as JSON.

  inspect <run-id> [--repo <path>]
      Print the complete persisted run state as JSON.

  cleanup <run-id> [--repo <path>]
      Force-remove that run's isolated worktree; persisted logs remain.

  wizard
      Open the optional interactive menu for human operators.

  help | --help | -h
      Show this help. This command works outside a Git repository.

Minimal task:
  {
    "name": "fix-authentication",
    "goal": "Fix the authentication failure and add regression coverage.",
    "verification": [
      { "type": "command", "name": "tests", "command": "npm test" }
    ]
  }

Execution contract:
  - The default is an isolated Git worktree based on HEAD.
  - Every configured verification gate must pass; an agent's claim is not enough.
  - The default delivery mode preserves changes in the worktree without committing.
  - In non-TTY use, run and resume print the final persisted state as JSON to stdout.
    Progress and errors use stderr. Use --quiet when consuming stdout programmatically.
  - Only status "success" means the run completed and all gates passed.
  - Terminal failure statuses are: no_progress, max_iterations, failed_to_start,
    cancelled, provider_error, delivery_failed, and timeout.
  - Inspect before cleanup. Preserve or deliver successful changes first.

Run Loops inside the Git repository it should change. See README.md for the full
task schema, provider behavior, delivery modes, storage layout, and security notes.
`;

function parseOptions(args, definitions) {
  const options = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const definition = definitions[arg];
    if (!definition) throw new ConfigError(`Unknown option: ${arg}`);
    if (definition === "boolean") {
      options[arg.slice(2)] = true;
    } else {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new ConfigError(`${arg} requires a value`);
      options[arg.slice(2)] = value;
      index += 1;
    }
  }
  return { options, positional };
}

function requireCount(positional, minimum, maximum, command) {
  if (positional.length < minimum || positional.length > maximum) {
    throw new ConfigError(`Invalid arguments for ${command}.\n\n${USAGE}`);
  }
}

async function repository(option) {
  return resolveRepoRoot(option ? path.resolve(option) : process.cwd());
}

function printRunResult(state) {
  if (!process.stdout.isTTY) {
    process.stdout.write(json(state));
    return;
  }
  process.stdout.write(
    [
      "",
      `Run ${state.id}: ${state.status}`,
      `Iterations: ${state.iteration}`,
      `Worktree: ${state.worktreePath}`,
      ...(state.delivery?.commitHash ? [`Commit: ${state.delivery.commitHash}`] : []),
      ...(state.delivery?.branch ? [`Branch: ${state.delivery.branch}`] : []),
      ...(state.delivery?.prUrl ? [`Pull request: ${state.delivery.prUrl}`] : []),
      ...(state.error ? [`Error: ${state.error}`] : []),
      `Inspect: loops inspect ${state.id}`,
      "",
    ].join("\n"),
  );
}

async function executeWithCancellation(context, display) {
  const controller = new AbortController();
  const cancel = () => {
    if (controller.signal.aborted) return;
    const activity = {
      ...context.state.activity,
      phase: "cancelling",
      message: "Stopping the active agent and preserving run state",
      startedAt: new Date().toISOString(),
    };
    display.update({ type: "activity.updated", runId: context.state.id, task: context.state.task, activity });
    controller.abort();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    return await executeRun(context, {
      signal: controller.signal,
      onProgress: (event) => display.update(event),
    });
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

async function init(args) {
  const { options, positional } = parseOptions(args, { "--interactive": "boolean", "--defaults": "boolean" });
  requireCount(positional, 0, 1, "init");
  if (options.interactive && options.defaults)
    throw new ConfigError("--interactive and --defaults cannot be used together");
  const interactive = options.interactive || (!options.defaults && process.stdin.isTTY && process.stdout.isTTY);
  if (interactive && !process.stdin.isTTY) throw new ConfigError("Interactive init requires a TTY");
  const taskPath = path.resolve(positional[0] ?? "loop.task.json");
  const repoRoot = await resolveRepoRoot(path.dirname(taskPath));
  const task = interactive ? await createTaskInteractively() : STARTER_TASK;
  try {
    await writeFile(taskPath, json(task), { flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") throw new ConfigError(`Refusing to overwrite existing task file: ${taskPath}`);
    throw error;
  }
  await initializeLoopDirectory(repoRoot);
  process.stdout.write(json({ created: taskPath, loopDirectory: path.join(repoRoot, ".loop") }));
}

async function validate(args) {
  const { positional } = parseOptions(args, {});
  requireCount(positional, 1, 1, "validate");
  const loaded = await loadTask(positional[0]);
  process.stdout.write(json(loaded.task));
}

async function run(args) {
  const { options, positional } = parseOptions(args, {
    "--dry-run": "boolean",
    "--no-worktree": "boolean",
    "--quiet": "boolean",
  });
  requireCount(positional, 1, 1, "run");
  if (options["dry-run"]) {
    const planned = await planRun(positional[0], { noWorktree: options["no-worktree"] });
    process.stdout.write(json({ dryRun: true, ...planned }));
    return;
  }
  const display = new LiveStatus({ quiet: options.quiet });
  display.start({
    startedAt: new Date().toISOString(),
    maxIterations: "?",
    activity: {
      phase: "preparing",
      message: "Validating task and preparing workspace",
      iteration: 0,
      startedAt: new Date().toISOString(),
    },
  });
  const context = await createRun(positional[0], { noWorktree: options["no-worktree"] });
  display.setState(context.state);
  const state = await executeWithCancellation(context, display);
  display.stop(state);
  printRunResult(state);
  if (state.status !== "success") process.exitCode = state.status === "cancelled" ? 130 : 1;
}

async function resume(args) {
  const { options, positional } = parseOptions(args, { "--task": "value", "--repo": "value", "--quiet": "boolean" });
  requireCount(positional, 1, 1, "resume");
  const repoRoot = await repository(options.repo);
  const context = await resumeRun(repoRoot, positional[0], { taskPath: options.task });
  if (context.alreadyComplete) {
    printRunResult(context.state);
    return;
  }
  const display = new LiveStatus({ quiet: options.quiet });
  display.startState(context.state);
  const state = await executeWithCancellation(context, display);
  display.stop(state);
  printRunResult(state);
  if (state.status !== "success") process.exitCode = state.status === "cancelled" ? 130 : 1;
}

async function reconcile(args) {
  const { options, positional } = parseOptions(args, { "--pr": "value", "--repo": "value" });
  requireCount(positional, 1, 1, "reconcile");
  const repoRoot = await repository(options.repo);
  const state = await reconcileRun(repoRoot, positional[0], { prUrl: options.pr });
  printRunResult(state);
}

async function watch(args) {
  const { options, positional } = parseOptions(args, { "--repo": "value", "--quiet": "boolean" });
  requireCount(positional, 1, 1, "watch");
  const repoRoot = await repository(options.repo);
  const runId = positional[0];
  const display = new LiveStatus({ quiet: options.quiet });
  let first = true;
  while (true) {
    const { state } = await loadState(repoRoot, runId);
    if (first) {
      display.startState(state);
      first = false;
    } else {
      display.setState(state);
    }
    if (
      [
        "success",
        "no_progress",
        "max_iterations",
        "failed_to_start",
        "cancelled",
        "provider_error",
        "delivery_failed",
        "timeout",
      ].includes(state.status)
    ) {
      display.stop(state);
      if (options.quiet) printRunResult(state);
      return;
    }
    await delay(1000);
  }
}

async function list(args) {
  const { options, positional } = parseOptions(args, { "--repo": "value" });
  requireCount(positional, 0, 0, "list");
  const repoRoot = await repository(options.repo);
  const states = await listStates(repoRoot);
  process.stdout.write(
    json(
      states.map((state) => ({
        id: state.id,
        task: state.task,
        status: state.status,
        iteration: state.iteration,
        noProgress: state.noProgress,
        phase: state.activity?.phase ?? state.status,
        current: state.activity?.message,
        worktreePath: state.worktreePath,
        updatedAt: state.updatedAt,
      })),
    ),
  );
}

async function inspect(args) {
  const { options, positional } = parseOptions(args, { "--repo": "value" });
  requireCount(positional, 1, 1, "inspect");
  const repoRoot = await repository(options.repo);
  const { state } = await loadState(repoRoot, positional[0]);
  process.stdout.write(json(state));
}

async function cleanup(args) {
  const { options, positional } = parseOptions(args, { "--repo": "value" });
  requireCount(positional, 1, 1, "cleanup");
  const repoRoot = await repository(options.repo);
  const runId = positional[0];
  const { state } = await loadState(repoRoot, runId);
  if (!state.worktreeEnabled) {
    process.stdout.write(json({ runId, removed: false, reason: "run did not use an isolated worktree" }));
    return;
  }
  const expected = loopPaths(repoRoot, runId).worktreePath;
  if (path.resolve(state.worktreePath) !== path.resolve(expected)) {
    throw new ConfigError(`Refusing cleanup: persisted worktree path is outside this run's expected location`);
  }
  if (!(await pathExists(expected))) {
    process.stdout.write(json({ runId, removed: false, reason: "worktree is already absent" }));
    return;
  }
  await removeWorktree({ repoRoot, worktreePath: expected });
  process.stdout.write(json({ runId, removed: true, worktreePath: expected, logsPreserved: true }));
}

async function chooseRunId(action) {
  const repoRoot = await resolveRepoRoot(process.cwd());
  const states = await listStates(repoRoot);
  if (!states.length) throw new ConfigError("No Loops runs were found in this repository");
  return select({
    message: `Choose a run to ${action}`,
    choices: states.map((state) => ({
      name: `${state.id}  ${state.status}  ${state.task}  iteration ${state.iteration}`,
      value: state.id,
    })),
  });
}

async function wizard() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ConfigError("The interactive wizard requires a TTY. Use loops help for command-line usage.");
  }
  try {
    await resolveRepoRoot(process.cwd());
  } catch (error) {
    throw new PreparationError(
      `Warning: no Git repository detected from ${process.cwd()}. Loops must run inside a Git repository. Change into the project directory or initialize one with: git init`,
      { cause: error },
    );
  }
  const action = await select({
    message: "What would you like to do?",
    choices: [
      { name: "Create a task", value: "init" },
      { name: "Run a task", value: "run" },
      { name: "Preview a task (dry run)", value: "dry-run" },
      { name: "Validate a task", value: "validate" },
      { name: "Resume an interrupted run", value: "resume" },
      { name: "Reconcile interrupted PR delivery", value: "reconcile" },
      { name: "Watch a run", value: "watch" },
      { name: "List runs", value: "list" },
      { name: "Inspect a run", value: "inspect" },
      { name: "Clean up a worktree", value: "cleanup" },
      { name: "Exit", value: "exit" },
    ],
  });

  if (action === "exit") return;
  if (action === "list") return list([]);
  if (["resume", "reconcile", "watch", "inspect", "cleanup"].includes(action)) {
    const runId = await chooseRunId(action);
    if (action === "resume") return resume([runId]);
    if (action === "reconcile") return reconcile([runId]);
    if (action === "watch") return watch([runId]);
    if (action === "inspect") return inspect([runId]);
    const approved = await confirm({ message: `Force-remove the worktree for ${runId}?`, default: false });
    if (approved) return cleanup([runId]);
    return;
  }

  const taskPath = await input({
    message: action === "init" ? "New task file" : "Task file",
    default: "loop.task.json",
    validate: (value) => (value.trim() ? true : "Enter a task file path"),
  });
  if (action === "init") return init([taskPath, "--interactive"]);
  if (action === "validate") return validate([taskPath]);
  if (action === "dry-run") return run([taskPath, "--dry-run"]);
  return run([taskPath]);
}

async function main(argv) {
  if (argv.length === 0) {
    if (process.stdin.isTTY && process.stdout.isTTY) return wizard();
    try {
      await resolveRepoRoot(process.cwd());
    } catch (error) {
      throw new PreparationError(
        `Warning: no Git repository detected from ${process.cwd()}. Loops must run inside a Git repository. Change into the project directory or initialize one with: git init`,
        { cause: error },
      );
    }
    process.stdout.write(USAGE);
    return;
  }
  const [command, ...args] = argv;
  switch (command) {
    case "init":
      return init(args);
    case "validate":
      return validate(args);
    case "run":
      return run(args);
    case "resume":
      return resume(args);
    case "reconcile":
      return reconcile(args);
    case "watch":
      return watch(args);
    case "list":
      return list(args);
    case "inspect":
      return inspect(args);
    case "cleanup":
      return cleanup(args);
    case "wizard":
      return wizard();
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return;
    default:
      throw new ConfigError(`Unknown command: ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`loops: ${message}\n`);
  process.exitCode = error instanceof LoopError ? error.exitCode : 1;
});
